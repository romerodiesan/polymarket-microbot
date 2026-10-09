import asyncio
import base64
import hashlib
import json
import secrets
from urllib.parse import parse_qs, urlparse

import pytest
from starlette.testclient import TestClient

from microbot import mcp_auth
from microbot.mcp_auth import SingleUserOAuthProvider
from microbot.mcp_server import HttpConfig, create_server, http_app

PUBLIC = "https://mcp.example.com"
PASSWORD = "correct-horse-battery-staple"
REDIRECT = "https://chatgpt.com/connector_platform_oauth_redirect"


@pytest.fixture
def state_file(tmp_path):
    return tmp_path / "mcp" / "oauth.json"


@pytest.fixture
def client(state_file, monkeypatch):
    monkeypatch.setattr(mcp_auth, "FAILURE_DELAY", 0)
    app = http_app(create_server(HttpConfig(PUBLIC, PASSWORD), state_file))
    with TestClient(app, base_url=PUBLIC, follow_redirects=False) as test_client:
        yield test_client


def register(client, auth_method="client_secret_post"):
    response = client.post(
        "/register",
        json={
            "redirect_uris": [REDIRECT],
            "client_name": "ChatGPT",
            "token_endpoint_auth_method": auth_method,
            "grant_types": ["authorization_code", "refresh_token"],
            "response_types": ["code"],
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def start_login(client, app_client, verifier):
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest())
    response = client.get(
        "/authorize",
        params={
            "response_type": "code",
            "client_id": app_client["client_id"],
            "redirect_uri": REDIRECT,
            "code_challenge": challenge.decode().rstrip("="),
            "code_challenge_method": "S256",
            "state": "xyz",
            "resource": f"{PUBLIC}/mcp",
        },
    )
    assert response.status_code == 302, response.text
    location = response.headers["location"]
    assert location.startswith(f"{PUBLIC}/login?request=")
    return parse_qs(urlparse(location).query)["request"][0]


def login(client, request_id, password=PASSWORD):
    return client.post("/login", data={"request": request_id, "password": password})


def authorize(client, app_client, verifier):
    response = login(client, start_login(client, app_client, verifier))
    assert response.status_code == 302, response.text
    redirect = urlparse(response.headers["location"])
    assert f"{redirect.scheme}://{redirect.netloc}{redirect.path}" == REDIRECT
    query = parse_qs(redirect.query)
    assert query["state"] == ["xyz"]
    return query["code"][0]


def exchange(client, app_client, code, verifier):
    return client.post(
        "/token",
        data={
            "grant_type": "authorization_code",
            "code": code,
            "redirect_uri": REDIRECT,
            "code_verifier": verifier,
            "client_id": app_client["client_id"],
            **(
                {"client_secret": app_client["client_secret"]}
                if "client_secret" in app_client
                else {}
            ),
        },
    )


def tokens(client, auth_method="client_secret_post"):
    app_client = register(client, auth_method)
    verifier = secrets.token_urlsafe(48)
    response = exchange(client, app_client, authorize(client, app_client, verifier), verifier)
    assert response.status_code == 200, response.text
    return app_client, response.json()


def rpc(client, token, method, params=None, session=None, request_id=1):
    headers = {
        "Authorization": f"Bearer {token}",
        "Accept": "application/json, text/event-stream",
        "MCP-Protocol-Version": "2025-06-18",
    }
    if session:
        headers["Mcp-Session-Id"] = session
    body = {"jsonrpc": "2.0", "method": method, "params": params or {}}
    if request_id is not None:
        body["id"] = request_id
    response = client.post("/mcp", json=body, headers=headers)
    messages = [
        json.loads(line[5:]) for line in response.text.splitlines() if line.startswith("data:")
    ]
    return response, messages[0] if messages else None


def test_unauthenticated_requests_get_discovery_metadata(client):
    response = client.post("/mcp", json={"jsonrpc": "2.0", "id": 1, "method": "ping"})
    assert response.status_code == 401
    challenge = response.headers["www-authenticate"]
    assert f"{PUBLIC}/.well-known/oauth-protected-resource/mcp" in challenge

    resource = client.get("/.well-known/oauth-protected-resource/mcp").json()
    assert resource["resource"] == f"{PUBLIC}/mcp"
    assert resource["authorization_servers"][0].startswith(PUBLIC)

    server = client.get("/.well-known/oauth-authorization-server").json()
    assert server["issuer"].startswith(PUBLIC)
    assert server["authorization_endpoint"] == f"{PUBLIC}/authorize"
    assert server["registration_endpoint"] == f"{PUBLIC}/register"
    assert "S256" in server["code_challenge_methods_supported"]
    assert "none" in server["token_endpoint_auth_methods_supported"]

    assert client.get("/healthz").text == "ok"


@pytest.mark.parametrize("auth_method", ["none", "client_secret_post"])
def test_full_flow_reaches_the_tools(client, auth_method):
    _, issued = tokens(client, auth_method)
    response, result = rpc(
        client,
        issued["access_token"],
        "initialize",
        {
            "protocolVersion": "2025-06-18",
            "capabilities": {},
            "clientInfo": {"name": "test", "version": "1"},
        },
    )
    assert response.status_code == 200, response.text
    assert result["result"]["serverInfo"]["name"] == "polymarket-microbot-analytics"
    session = response.headers.get("mcp-session-id")
    rpc(
        client,
        issued["access_token"],
        "notifications/initialized",
        session=session,
        request_id=None,
    )

    _, listed = rpc(client, issued["access_token"], "tools/list", session=session, request_id=2)
    names = {tool["name"] for tool in listed["result"]["tools"]}
    assert {"get_capture_status", "get_paper_performance", "compare_training_runs"} <= names
    assert all(tool["annotations"]["readOnlyHint"] for tool in listed["result"]["tools"])


def test_login_page_and_wrong_password(client):
    app_client = register(client)
    request_id = start_login(client, app_client, secrets.token_urlsafe(48))
    page = client.get("/login", params={"request": request_id})
    assert page.status_code == 200
    assert "ChatGPT" in page.text and "chatgpt.com" in page.text
    assert page.headers["cache-control"] == "no-store"
    assert page.headers["x-frame-options"] == "DENY"
    assert page.headers["content-security-policy"].endswith(
        "form-action 'self' https://chatgpt.com"
    )

    assert login(client, request_id, "wrong").status_code == 401
    assert login(client, "unknown").status_code == 400
    assert client.get("/login", params={"request": "unknown"}).status_code == 400


def test_codes_are_single_use_and_need_the_verifier(client):
    app_client = register(client)
    verifier = secrets.token_urlsafe(48)
    code = authorize(client, app_client, verifier)
    wrong = exchange(client, app_client, code, secrets.token_urlsafe(48))
    assert wrong.status_code == 400

    verifier = secrets.token_urlsafe(48)
    code = authorize(client, app_client, verifier)
    assert exchange(client, app_client, code, verifier).status_code == 200
    reused = exchange(client, app_client, code, verifier)
    assert reused.status_code == 400
    assert reused.json()["error"] == "invalid_grant"


def test_refresh_rotates_tokens(client):
    app_client, issued = tokens(client)
    refresh = {
        "grant_type": "refresh_token",
        "refresh_token": issued["refresh_token"],
        "client_id": app_client["client_id"],
        "client_secret": app_client["client_secret"],
    }
    rotated = client.post("/token", data=refresh)
    assert rotated.status_code == 200, rotated.text
    assert rotated.json()["refresh_token"] != issued["refresh_token"]
    assert client.post("/token", data=refresh).status_code == 400

    hello = {
        "protocolVersion": "2025-06-18",
        "capabilities": {},
        "clientInfo": {"name": "test", "version": "1"},
    }
    stale, _ = rpc(client, issued["access_token"], "initialize", hello)
    assert stale.status_code == 401
    fresh, _ = rpc(client, rotated.json()["access_token"], "initialize", hello)
    assert fresh.status_code == 200


def test_state_is_hashed_and_survives_restarts(client, state_file):
    _, issued = tokens(client)
    stored = state_file.read_text()
    assert issued["access_token"] not in stored
    assert issued["refresh_token"] not in stored
    assert state_file.stat().st_mode & 0o777 == 0o600

    restarted = SingleUserOAuthProvider(PUBLIC, PASSWORD, state_file)
    assert asyncio.run(restarted.load_access_token(issued["access_token"])) is not None
    assert asyncio.run(restarted.load_access_token("forged")) is None


def test_login_is_throttled(client):
    app_client = register(client)
    request_id = start_login(client, app_client, secrets.token_urlsafe(48))
    for _ in range(mcp_auth.MAX_FAILURES):
        assert login(client, request_id, "wrong").status_code == 401
    assert login(client, request_id).status_code == 429


@pytest.mark.parametrize(
    "environ",
    [
        {},
        {"MICROBOT_MCP_PUBLIC_URL": "http://mcp.example.com", "MICROBOT_MCP_PASSWORD": PASSWORD},
        {"MICROBOT_MCP_PUBLIC_URL": f"{PUBLIC}/mcp", "MICROBOT_MCP_PASSWORD": PASSWORD},
        {"MICROBOT_MCP_PUBLIC_URL": PUBLIC, "MICROBOT_MCP_PASSWORD": "short"},
    ],
)
def test_invalid_http_config(environ):
    with pytest.raises(ValueError):
        HttpConfig.from_env(environ)


def test_valid_http_config():
    config = HttpConfig.from_env(
        {"MICROBOT_MCP_PUBLIC_URL": f"{PUBLIC}/", "MICROBOT_MCP_PASSWORD": PASSWORD}
    )
    assert config == HttpConfig(PUBLIC, PASSWORD, "127.0.0.1", 8765)
