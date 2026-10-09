"""Single-user OAuth 2.1 authorization server for the remote MCP endpoint.

FastMCP serves the standard endpoints (/authorize, /token, /register, /revoke, metadata) and checks
PKCE and bearer tokens; this module stores clients and tokens and adds the password login page.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import html
import json
import os
import secrets
import time
from collections import deque
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from mcp.server.auth.provider import (
    AccessToken,
    AuthorizationCode,
    AuthorizationParams,
    RefreshToken,
    construct_redirect_uri,
)
from mcp.server.fastmcp import FastMCP
from mcp.shared.auth import OAuthClientInformationFull, OAuthToken
from starlette.requests import Request
from starlette.responses import HTMLResponse, RedirectResponse, Response

SCOPE = "read"
SUBJECT = "owner"
ACCESS_TTL = 3600
REFRESH_TTL = 30 * 86400
CODE_TTL = 300
REQUEST_TTL = 600
MAX_FAILURES = 5
FAILURE_WINDOW = 15 * 60
FAILURE_DELAY = 1.0


def digest(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


@dataclass
class PendingLogin:
    client: OAuthClientInformationFull
    params: AuthorizationParams
    expires_at: float


class SingleUserOAuthProvider:
    """Clients, refresh and access tokens persist (tokens only as SHA-256) so restarts keep sessions."""

    def __init__(self, public_url: str, password: str, state_file: Path) -> None:
        self.public_url = public_url.rstrip("/")
        self.password = password
        self.state_file = state_file
        self.pending: dict[str, PendingLogin] = {}
        self.codes: dict[str, AuthorizationCode] = {}
        self.failures: dict[str, deque[float]] = {}
        state = self._read()
        self.clients: dict[str, dict[str, Any]] = state.get("clients", {})
        self.refresh: dict[str, dict[str, Any]] = state.get("refresh", {})
        self.access: dict[str, dict[str, Any]] = state.get("access", {})

    # Persistence

    def _read(self) -> dict[str, Any]:
        try:
            with self.state_file.open() as handle:
                data = json.load(handle)
        except (FileNotFoundError, json.JSONDecodeError, OSError):
            return {}
        return data if isinstance(data, dict) else {}

    def _save(self) -> None:
        now = time.time()
        self.refresh = {k: v for k, v in self.refresh.items() if v["expires_at"] > now}
        self.access = {k: v for k, v in self.access.items() if v["expires_at"] > now}
        self.state_file.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.state_file.with_suffix(".tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w") as handle:
            json.dump(
                {"clients": self.clients, "refresh": self.refresh, "access": self.access}, handle
            )
        os.replace(tmp, self.state_file)

    # Clients

    async def get_client(self, client_id: str) -> OAuthClientInformationFull | None:
        stored = self.clients.get(client_id)
        return OAuthClientInformationFull.model_validate(stored) if stored else None

    async def register_client(self, client_info: OAuthClientInformationFull) -> None:
        self.clients[client_info.client_id] = client_info.model_dump(mode="json", exclude_none=True)
        self._save()

    # Authorization

    async def authorize(
        self, client: OAuthClientInformationFull, params: AuthorizationParams
    ) -> str:
        now = time.time()
        self.pending = {k: v for k, v in self.pending.items() if v.expires_at > now}
        request_id = secrets.token_urlsafe(32)
        self.pending[request_id] = PendingLogin(client, params, now + REQUEST_TTL)
        return f"{self.public_url}/login?request={request_id}"

    def complete_login(self, request_id: str) -> str | None:
        """Issue a one-time code for an approved request; returns the client's redirect URL."""
        login = self.pending.pop(request_id, None)
        if not login or login.expires_at < time.time():
            return None
        code = secrets.token_urlsafe(32)
        params = login.params
        self.codes[code] = AuthorizationCode(
            code=code,
            scopes=params.scopes or [SCOPE],
            expires_at=time.time() + CODE_TTL,
            client_id=login.client.client_id,
            code_challenge=params.code_challenge,
            redirect_uri=params.redirect_uri,
            redirect_uri_provided_explicitly=params.redirect_uri_provided_explicitly,
            resource=params.resource,
            subject=SUBJECT,
        )
        return construct_redirect_uri(str(params.redirect_uri), code=code, state=params.state)

    async def load_authorization_code(
        self, client: OAuthClientInformationFull, authorization_code: str
    ) -> AuthorizationCode | None:
        code = self.codes.get(authorization_code)
        return code if code and code.client_id == client.client_id else None

    async def exchange_authorization_code(
        self, client: OAuthClientInformationFull, authorization_code: AuthorizationCode
    ) -> OAuthToken:
        self.codes.pop(authorization_code.code, None)
        return self._issue(client.client_id, authorization_code.scopes, authorization_code.resource)

    # Tokens

    def _issue(self, client_id: str, scopes: list[str], resource: str | None) -> OAuthToken:
        now = int(time.time())
        access, refresh = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
        grant = {"client_id": client_id, "scopes": scopes, "resource": resource}
        self.access[digest(access)] = {
            **grant,
            "expires_at": now + ACCESS_TTL,
            "refresh": digest(refresh),
        }
        self.refresh[digest(refresh)] = {
            **grant,
            "expires_at": now + REFRESH_TTL,
            "access": digest(access),
        }
        self._save()
        return OAuthToken(
            access_token=access,
            token_type="Bearer",
            expires_in=ACCESS_TTL,
            scope=" ".join(scopes),
            refresh_token=refresh,
        )

    async def load_refresh_token(
        self, client: OAuthClientInformationFull, refresh_token: str
    ) -> RefreshToken | None:
        stored = self.refresh.get(digest(refresh_token))
        if (
            not stored
            or stored["client_id"] != client.client_id
            or stored["expires_at"] < time.time()
        ):
            return None
        return RefreshToken(
            token=refresh_token,
            client_id=stored["client_id"],
            scopes=stored["scopes"],
            expires_at=stored["expires_at"],
            resource=stored.get("resource"),
            subject=SUBJECT,
        )

    async def exchange_refresh_token(
        self, client: OAuthClientInformationFull, refresh_token: RefreshToken, scopes: list[str]
    ) -> OAuthToken:
        self._drop_refresh(digest(refresh_token.token))
        return self._issue(client.client_id, scopes, refresh_token.resource)

    async def load_access_token(self, token: str) -> AccessToken | None:
        stored = self.access.get(digest(token))
        if not stored or stored["expires_at"] < time.time():
            return None
        return AccessToken(
            token=token,
            client_id=stored["client_id"],
            scopes=stored["scopes"],
            expires_at=stored["expires_at"],
            resource=stored.get("resource"),
            subject=SUBJECT,
        )

    async def revoke_token(self, token: AccessToken | RefreshToken) -> None:
        key = digest(token.token)
        if isinstance(token, RefreshToken):
            self._drop_refresh(key)
        else:
            stored = self.access.pop(key, None)
            if stored:
                self.refresh.pop(stored.get("refresh", ""), None)
        self._save()

    def _drop_refresh(self, key: str) -> None:
        stored = self.refresh.pop(key, None)
        if stored:
            self.access.pop(stored.get("access", ""), None)

    # Login throttling

    def blocked(self, ip: str) -> bool:
        attempts = self.failures.get(ip)
        if not attempts:
            return False
        cutoff = time.time() - FAILURE_WINDOW
        while attempts and attempts[0] < cutoff:
            attempts.popleft()
        return len(attempts) >= MAX_FAILURES

    def record_failure(self, ip: str) -> None:
        self.failures.setdefault(ip, deque()).append(time.time())


def client_ip(request: Request) -> str:
    peer = request.client.host if request.client else ""
    forwarded = request.headers.get("x-forwarded-for")
    # Only the local reverse proxy (Caddy) is trusted; it appends the real client last.
    if forwarded and peer in {"127.0.0.1", "::1"}:
        return forwarded.split(",")[-1].strip()
    return peer


PAGE = """<!doctype html>
<html lang="es"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>microbot MCP</title>
<style>
body{{font-family:system-ui,sans-serif;background:#0b0b0c;color:#e7e7e9;display:grid;
place-items:center;min-height:100vh;margin:0}}
form{{background:#151517;border:1px solid #2a2a2e;border-radius:12px;padding:28px;width:320px}}
h1{{font-size:18px;margin:0 0 8px}}p{{color:#9a9aa2;font-size:14px;margin:0 0 16px}}
input{{width:100%;box-sizing:border-box;padding:10px;border-radius:8px;border:1px solid #2a2a2e;
background:#0b0b0c;color:inherit;margin-bottom:12px}}
button{{width:100%;padding:10px;border:0;border-radius:8px;background:#e7e7e9;color:#0b0b0c;
font-weight:600;cursor:pointer}}.error{{color:#f87171}}
</style></head><body>
<form method="post" action="/login">
<h1>Acceso de solo lectura</h1>
<p><strong>{client}</strong> quiere leer los datos del microbot y volverá a <strong>{host}</strong>.</p>
{error}
<input type="hidden" name="request" value="{request}">
<input type="password" name="password" placeholder="Contraseña" autofocus required>
<button type="submit">Autorizar</button>
</form></body></html>"""

HEADERS = {
    "Cache-Control": "no-store",
    "X-Frame-Options": "DENY",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
    "Referrer-Policy": "no-referrer",
}


def render(
    login: PendingLogin, request_id: str, error: str = "", status: int = 200
) -> HTMLResponse:
    client = login.client.client_name or login.client.client_id
    body = PAGE.format(
        client=html.escape(client),
        host=html.escape(urlparse(str(login.params.redirect_uri)).netloc),
        request=html.escape(request_id),
        error=f'<p class="error">{html.escape(error)}</p>' if error else "",
    )
    return HTMLResponse(body, status_code=status, headers=HEADERS)


def expired() -> Response:
    return HTMLResponse(
        "<p>La solicitud de autorización caducó. Vuelve a conectar desde el cliente.</p>",
        status_code=400,
        headers=HEADERS,
    )


def install_login(server: FastMCP, provider: SingleUserOAuthProvider) -> None:
    @server.custom_route("/login", methods=["GET", "POST"])
    async def login(request: Request) -> Response:
        if request.method == "GET":
            request_id = request.query_params.get("request", "")
            pending = provider.pending.get(request_id)
            if not pending or pending.expires_at < time.time():
                return expired()
            return render(pending, request_id)

        form = await request.form()
        request_id = str(form.get("request", ""))
        pending = provider.pending.get(request_id)
        if not pending or pending.expires_at < time.time():
            return expired()
        ip = client_ip(request)
        if provider.blocked(ip):
            return render(pending, request_id, "Demasiados intentos. Prueba más tarde.", 429)
        password = str(form.get("password", ""))
        if not hmac.compare_digest(password.encode(), provider.password.encode()):
            provider.record_failure(ip)
            await asyncio.sleep(FAILURE_DELAY)
            return render(pending, request_id, "Contraseña incorrecta.", 401)
        redirect = provider.complete_login(request_id)
        if not redirect:
            return expired()
        return RedirectResponse(redirect, status_code=302, headers={"Cache-Control": "no-store"})
