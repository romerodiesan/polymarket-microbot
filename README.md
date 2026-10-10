# Polymarket Microbot

Bot experimental de microestructura para mercados binarios de Polymarket. Reconstruye el libro L2,
calcula order flow imbalance (OFI), desequilibrio ponderado del libro, `microprice`, presión de trades y
volatilidad, y las combina en una única señal por mercado. Guarda observaciones en DuckDB/Parquet y opera
en **paper mode por defecto**.

> Software de investigación, no una promesa de rentabilidad. El simulador recorre el libro visible pero
> no modela latencia, cola ni impacto en el mercado, así que sigue siendo optimista. Cumple las reglas de
> Polymarket y de tu jurisdicción.

El repositorio tiene dos partes independientes:

```text
bot/         bot en Python: configuración (.env), datos (data/) y su virtualenv (.bot/)
dashboard/   app Next.js que lee los datos del bot y lo inicia, detiene y entrena
```

## Instalación

Todo lo del bot se ejecuta dentro de `bot/`:

```bash
cd bot
python3 -m venv .bot
source .bot/bin/activate
pip install -e '.[dev]'
cp .env.example .env
```

En `bot/.env`, coloca los token IDs de **YES** y **NO**, no el condition ID:

```dotenv
PM_YES_TOKEN_ID=...
PM_NO_TOKEN_ID=...
PM_MODE=paper
```

Para mercados que se renuevan (BTC/ETH/SOL/XRP "Up or Down" de 5 min, 15 min o por hora), usa la serie
en lugar de los token IDs. El bot busca el mercado abierto de la serie en la Gamma API, lo sigue hasta
`PM_ROLLOVER_SECONDS` (30 s) antes del cierre, vende las posiciones abiertas (motivo `rollover`) y pasa
al siguiente:

```dotenv
PM_SERIES_SLUG=btc-up-or-down-15m   # o btc-up-or-down-5m, btc-up-or-down-hourly, eth-up-or-down-15m…
```

Cada fila de `features` y `fills` guarda el `market` (slug) y el `outcome` (`YES` = primer resultado,
p. ej. "Up"; `NO` = segundo).

Ejecuta desde `bot/` (o inícialo desde el dashboard):

```bash
microbot
```

Mientras corre (cada `PM_EXPORT_INTERVAL_SECONDS`, 5 s por defecto) y al detenerlo con `Ctrl+C`, genera
en `bot/`:

- `data/microbot.duckdb`
- `data/parquet/features.parquet`
- `data/parquet/fills.parquet`

## Dashboard

`dashboard/` es una app Next.js que lee esos Parquet de `../bot` (cámbialo con `MICROBOT_ROOT`). Pide la
contraseña `DASHBOARD_PASSWORD` de `bot/.env`, y desde la barra superior inicia y detiene el bot con el
virtualenv `bot/.bot` (o `bot/.venv`). Tiene cuatro secciones:

- **En vivo** (`/`): el bot en vivo o en modo reproducción (bid/ask/mid con las operaciones, score,
  equity/PnL, fills y órdenes). Muestra comisiones, tasa de fill, slippage frente al touch y latencia,
  la resolución oficial del mercado y las liquidaciones a 0/1. El panel **Libro L2** enseña las
  escaleras YES/NO (10 niveles), mid, spread, desequilibrio y profundidad acumulada: en vivo lee
  `data/bot/book.json` y, al reproducir o si ese archivo tiene más de 5 s, reconstruye el libro en ese
  instante desde `book_events`.
- **Datos** (`/data`): resumen de la recopilación (filas, sesiones, filas por minuto, estadísticas de
  features, preparación para entrenar y últimas filas), salud del stream de las últimas 24 h
  (reconexiones, huecos, resyncs, RTT) y tamaño del L2 en disco por día con la estimación según la
  retención.
- **Entrenamiento** (`/training`): lanza y detiene `microbot-train`, con historial, métricas,
  coeficientes y log. Muestra el split por mercados, el walk-forward, la curva de calibración, los
  baselines y la accuracy por mercado. Cada ejecución se guarda en `bot/data/training/<id>/` (modelo,
  métricas y log) y entrena desde el Parquet exportado, así que funciona con el bot en marcha.
- **Evaluación** (`/evaluation`): lanza `microbot-evaluate` con un modelo entrenado (o el score
  heurístico) y muestra escenarios, PnL acumulado por mercado, baselines, paper frente a replay,
  desglose semanal y folds. Cada evaluación queda en `bot/data/evaluations/<id>/`.

El bot escribe `book.json` cada `PM_BOOK_STATE_SECONDS` con los `PM_BOOK_STATE_DEPTH` mejores niveles
de cada token del mercado actual.

```bash
cd dashboard
npm install
npm run dev   # http://localhost:3000
```

Consultas rápidas:

```sql
SELECT token_id, count(*) samples, avg(score), avg(spread)
FROM features GROUP BY token_id;

SELECT * FROM fills ORDER BY ts DESC LIMIT 20;
```

## Entrenar el modelo base

Después de recopilar suficientes datos (preferiblemente varias sesiones y regímenes), desde `bot/`:

```bash
microbot-train --db data/microbot.duckdb --output data/model.joblib --horizon-seconds 15
```

Actívalo en `.env` y vuelve a ejecutar el bot:

```dotenv
PM_MODEL_PATH=data/model.joblib
```

El entrenador usa regresión logística. Etiqueta cada observación con el movimiento del midpoint
`--horizon-seconds` después, y solo cuenta movimientos mayores que medio spread más `--min-move`, es
decir, que cubrirían el coste de cruzar. Solo usa filas con el conjunto de features actual.

- **Split por mercado:** cada mercado (YES y NO juntos) cae entero en un solo lado. El último 20 % de los
  mercados (`--holdout-markets`) es el bloque de prueba y no se toca durante el ajuste. Entre bloques se
  descarta un mercado (`--embargo-markets`) y toda fila cuya etiqueta alcance el bloque siguiente.
- **Walk-forward** con ventana creciente (`--folds`, 4 por defecto): AUC, log loss, Brier y accuracy por fold.
- **Calibración de Platt** y **umbral de confianza** elegidos solo con el último bloque de validación;
  curva de fiabilidad y ECE antes y después de calibrar.
- **Baselines** (prior constante, signo del `score` heurístico y momentum) con las mismas métricas,
  métricas por mercado e intervalos de confianza por bootstrap de mercados (`--bootstrap`).
- `model_version` y `features_version` se guardan en el `.joblib` y en `metrics.json`.

Necesita al menos `--folds + 3` mercados con etiquetas. Nada de esto equivale a rentabilidad: para eso
está `microbot-evaluate`.

## Evaluar la estrategia

`microbot-evaluate` reproduce cronológicamente las features y la estrategia sobre los Parquet de
`data/` y escribe `data/evaluations/<id>/report.json`:

```bash
microbot-evaluate --fetch-resolutions                     # score grabado
microbot-evaluate --model data/model.joblib --walk-forward  # con un modelo; reentrena por fold
```

- Ejecuta contra el libro L2 grabado (`book_events`) si existe; si no, contra un libro aproximado con
  top y depth, y lo marca (`fidelity`).
- Liquida a 0/1 con el pago oficial de `markets`. `--fetch-resolutions` consulta en Gamma los pagos y
  metadatos (tick, comisión) que falten, útil para datos grabados antes de este registro. Los mercados
  sin resolver que acaban con inventario se excluyen y se cuentan.
- Tres escenarios: `base`, `pessimistic` y `stress` (latencia ×1/×2/×4, +0/1/2 ticks, comisión
  ×1/×1,5/×2 y haircut de fill 1/0,5/0,25). La latencia base es `PM_PAPER_LATENCY_MS` o la RTT medida.
- El informe incluye PnL neto, expectancy por operación y mercado, ROI sobre el capital máximo
  comprometido, Sharpe/Sortino por mercado, profit factor, win rate, drawdown y su duración, desglose
  semanal, concentración, bootstrap por mercados, baselines (momentum y aleatorio) y la degradación
  del paper registrado frente a cada escenario.

## Servidor MCP de analítica

`microbot-mcp` expone los datos del bot a un agente (Cursor, Claude, etc.) por stdio, **solo en lectura**:
consulta los Parquet exportados con DuckDB en memoria (sin bloquear `microbot.duckdb`), el estado del
proceso en `data/bot/state.json` y las ejecuciones de `data/training/`. Del `.env` solo expone `PM_MODE` y
`PM_SERIES_SLUG`. Se instala con el bot (`pip install -e .`).

| Herramienta | Devuelve |
| --- | --- |
| `get_capture_status` | Proceso, frescura del export, filas y tamaño de los Parquet, número de entrenamientos |
| `get_market_summary` | Midpoint, spread (media y p95), profundidad y señales por token |
| `get_recent_features` | Últimas observaciones (máximo `MICROBOT_MCP_MAX_ROWS`, 500) |
| `get_data_quality` | Intervalos de muestreo, huecos y timestamps duplicados |
| `get_paper_performance` | PnL liquidado a 0/1 (mercados resueltos) y marcado al mid (pendientes), comisiones y su fuente, ROI y fills por motivo |
| `list_training_runs` / `get_training_run` / `compare_training_runs` | Parámetros, datos, métricas y coeficientes de cada entrenamiento |
| `get_execution_quality` | Tasa de fill, parciales, rechazos y motivo, slippage, latencia y comisiones por mercado y motivo |
| `get_market_resolutions` | Resolución oficial, precio de BTC al inicio y al final, tick, comisión y PnL por mercado |
| `get_equity_and_risk` | Curva de equity submuestreada, drawdown, exposición, capital comprometido y posiciones abiertas |
| `get_prediction_calibration` | Fiabilidad de las predicciones registradas frente al mid posterior y frente a la resolución |
| `get_stream_health` | Conexiones, desconexiones, huecos, resyncs, libros caducados y RTT al CLOB |
| `get_cost_config` | Fórmula de comisiones, ajustes de ejecución paper de la última ejecución y comisión por mercado |
| `list_evaluations` / `get_evaluation` / `compare_evaluations` | Informes de `microbot-evaluate` |

El repo incluye `.cursor/mcp.json`, que lo registra en Cursor con el virtualenv `bot/.bot`. La carpeta de
datos se toma de `MICROBOT_DATA_DIR` o, si no está, de `bot/data`.

Para consultar el bot de un VPS sin abrir puertos, lanza el servidor por SSH (stdio sobre la conexión):

```json
{
  "mcpServers": {
    "microbot-vps": {
      "command": "ssh",
      "args": ["usuario@vps", "/ruta/al/repo/bot/.bot/bin/microbot-mcp"]
    }
  }
}
```

### MCP remoto (ChatGPT)

`microbot-mcp --http` sirve el mismo MCP por Streamable HTTP en `127.0.0.1:8765` con un servidor OAuth
propio de un solo usuario: ChatGPT se registra solo (registro dinámico), abre una página de login y tú
escribes la contraseña. Los tokens duran 1 h (refresh de 30 días, rotado en cada uso) y se guardan solo
como SHA-256 en `data/mcp/oauth.json`. El login se bloquea 15 min tras 5 fallos por IP. En el VPS, desde
`/srv/bot/bot` (los archivos están en [`deploy/`](deploy/)):

1. DNS: registro `A` de `mcp.midominio.com` a la IP del VPS.
2. Configuración:

   ```bash
   cp ../deploy/env.mcp.example .env.mcp && chmod 600 .env.mcp
   openssl rand -base64 24   # pégala en MICROBOT_MCP_PASSWORD
   mkdir -p data/mcp
   ```

3. Servicio (ajusta `User`/`Group` a la cuenta que ejecuta el bot):

   ```bash
   sudo cp ../deploy/microbot-mcp.service /etc/systemd/system/
   sudo systemctl daemon-reload && sudo systemctl enable --now microbot-mcp
   journalctl -u microbot-mcp -f
   ```

4. Caddy: añade el bloque de `deploy/Caddyfile.mcp` junto al de `bot.midominio.com` y
   `sudo systemctl reload caddy`. Caddy obtiene el certificado solo.
5. Prueba: `curl https://mcp.midominio.com/healthz` devuelve `ok`, y
   `curl -i -X POST https://mcp.midominio.com/mcp` devuelve `401`.
6. ChatGPT: activa el modo desarrollador en los ajustes de conectores/apps, crea un conector con la URL
   `https://mcp.midominio.com/mcp` y autenticación OAuth. Se abre el login; al autorizar vuelve a ChatGPT
   con las herramientas.

Para cortar el acceso, borra `data/mcp/oauth.json` (y cambia la contraseña si se filtró) y
`sudo systemctl restart microbot-mcp`.

## Modos

- `record`: captura y calcula features sin operar.
- `paper`: simula decisiones y fills; es el valor predeterminado.
- `live`: envía órdenes FAK mediante el cliente oficial y requiere la confirmación explícita descrita abajo.

## Activación de live trading

Instala el extra y rellena las credenciales únicamente en `.env`:

```bash
pip install -e '.[live]'
```

```dotenv
PM_MODE=live
PM_PRIVATE_KEY=...
PM_FUNDER=...
PM_SIGNATURE_TYPE=0
PM_ENABLE_LIVE_TRADING=I_UNDERSTAND_THE_RISK
```

Puedes proporcionar `PM_API_KEY`, `PM_API_SECRET` y `PM_API_PASSPHRASE`; si no, el cliente intentará
derivarlas. No uses una wallet principal: crea una wallet dedicada con capital limitado.

### Importante antes de producción

El adaptador live es deliberadamente mínimo. Antes de exponer capital debes implementar reconciliación
de balances/fills desde el canal autenticado, comprobar tick size y minimum order size por mercado,
validar fees, añadir kill switch persistente y probar ejecuciones parciales. Empieza en `record`, después
`paper`, y compara los fills simulados con el libro real.

## Señal y estrategia

Por token, el motor calcula en cada evento del libro el OFI de Cont–Kukanov–Stoikov y la presión de
trades como sumas con decaimiento temporal (`PM_SIGNAL_HALF_LIFE_SECONDS`). En cada muestra normaliza
cuatro componentes con un z-score EWMA (`PM_ZSCORE_HALF_LIFE_SECONDS`, sin señal durante las primeras
`PM_ZSCORE_WARMUP_SAMPLES` muestras) y los combina:

```text
score_token = tanh(0.35·z(weighted_imbalance) + 0.30·z(ofi) + 0.20·z(trade_pressure) + 0.15·z(microprice_delta))
señal       = (score_YES − score_NO) / 2       # YES y NO son complementarios
```

El `score` guardado es `señal` para YES y `−señal` para NO. La estrategia:

- Mantiene como máximo **un lado** del mercado; para cambiar de lado primero cierra la posición.
- Entra en el token favorecido solo si `|señal| ≥ PM_SIGNAL_THRESHOLD + PM_SPREAD_PENALTY · spread_ticks`,
  el precio está entre `PM_MIN_PRICE` y `PM_MAX_PRICE`, la volatilidad no supera `PM_MAX_VOLATILITY` y el
  spread y la profundidad pasan los filtros.
- Dimensiona entre la mitad y el total de `PM_ORDER_SIZE_SHARES` según la convicción, con tope en
  `PM_MAX_TOP_PARTICIPATION` del tamaño visible en el mejor ask.
- Sale por `take_profit`, `stop_loss`, `max_hold`, `signal_reversal` (la señal cruza `−PM_EXIT_THRESHOLD`) o
  `signal_faded` (señal neutra tras `PM_MIN_HOLD_SECONDS`). El motivo queda en `fills.reason`.
- Envía órdenes FAK con límite `mejor precio ± PM_MAX_SLIPPAGE`. En paper, el fill recorre el libro
  después de la latencia y puede ser parcial; `fills.pnl` registra el PnL realizado de cada venta.
- Al resolverse el mercado, lo que siga abierto se liquida con un fill `reason="settlement"` al pago
  oficial (0 o 1).

**Comisiones:** `fee = acciones · tasa · (p·(1−p))^exponente`, redondeada a 5 decimales y solo para el
taker ([documentación](https://docs.polymarket.com/trading/fees)). La tasa sale del `feeSchedule` de
Gamma de cada mercado (0,07 en cripto); si falta, del `base_fee` del CLOB (0 = sin comisión) y si no,
de `PM_FEE_RATE`. Cada fill y orden guarda `fee_source`.

**Registro:** además de `features` y `fills`, cada arranque (`run_id`) escribe `runs`, `markets` (con su
resolución), `orders` (ciclo completo, precios al decidir y al ejecutar), `equity` y `positions` (cada
5 s y en cada fill), `predictions` (antes de enviar órdenes, con decisión y motivo) y `stream_events`.
El libro L2 crudo va a `data/parquet/book_events/<YYYYMMDD-HH>[-n].parquet`, compactado por hora; los
snapshots repetidos solo guardan los niveles que cambian. En un mercado BTC de 15 min activo son unos
35 millones de eventos y ~250 MB al día; ajusta la retención con `PM_BOOK_RETENTION_DAYS`.

| Variable | Defecto | Uso |
| --- | --- | --- |
| `PM_SIGNAL_HALF_LIFE_SECONDS` | 5 | Decaimiento del OFI y la presión de trades |
| `PM_ZSCORE_HALF_LIFE_SECONDS` | 900 | Memoria de la normalización |
| `PM_ZSCORE_WARMUP_SAMPLES` | 30 | Muestras antes de emitir señal |
| `PM_WEIGHT_IMBALANCE` / `_OFI` / `_PRESSURE` / `_MICROPRICE` | 0.35 / 0.30 / 0.20 / 0.15 | Pesos del score |
| `PM_SPREAD_PENALTY` | 0.02 | Señal extra exigida por tick de spread |
| `PM_MIN_PRICE` / `PM_MAX_PRICE` | 0.05 / 0.95 | Rango de precios operable |
| `PM_MAX_VOLATILITY` | 0.05 | Volatilidad máxima del mid por minuto |
| `PM_TAKE_PROFIT` / `PM_STOP_LOSS` | 0.03 / 0.02 | Salidas sobre el mid frente al precio de entrada |
| `PM_MIN_HOLD_SECONDS` / `PM_MAX_HOLD_SECONDS` | 10 / 600 | Tiempo mínimo antes de salida neutra y máximo en posición |
| `PM_MAX_SLIPPAGE` | 0.01 | Distancia máxima del límite FAK al mejor precio |
| `PM_MAX_TOP_PARTICIPATION` | 0.5 | Fracción máxima del tamaño del mejor nivel |
| `PM_MIN_ORDER_SHARES` | 1 | Tamaño mínimo de orden |
| `PM_FEE_RATE` | 0.07 | Tasa de comisión si Gamma y el CLOB no la dan |
| `PM_PAPER_LATENCY_MS` | RTT medida | Latencia simulada antes de cruzar el libro en paper |
| `PM_PAPER_EXTRA_SLIPPAGE_TICKS` | 0 | Ticks extra en contra en cada fill paper |
| `PM_PAPER_FILL_HAIRCUT` | 1 | Fracción del tamaño visible disponible en paper |
| `PM_RECORD_BOOK_EVENTS` | true | Guardar el libro L2 crudo |
| `PM_BOOK_RETENTION_DAYS` | 14 | Días de `book_events` que se conservan (0 = todos) |
| `PM_GAP_SECONDS` | 5 | Silencio de un token que cuenta como hueco (`in_gap`) |
| `PM_BOOK_STATE_SECONDS` | 1 | Cada cuánto se escribe el libro actual para el dashboard (0 = nunca) |
| `PM_BOOK_STATE_PATH` | data/bot/book.json | Archivo del libro actual |
| `PM_BOOK_STATE_DEPTH` | 20 | Niveles por lado en ese archivo |

Los pesos y umbrales son un punto de partida, no parámetros optimizados.

## Pruebas

```bash
cd bot
pytest -q
ruff check .

cd ../dashboard
npm run test:store   # caché de Parquet
npm run test:book    # replay del L2 frente al bot
npx tsc --noEmit && npm run lint
```

## Estructura

```text
bot/src/microbot/book.py       libro L2 local
bot/src/microbot/features.py   variables de microestructura
bot/src/microbot/strategy.py   reglas de entrada y salida
bot/src/microbot/positions.py  inventario, precio medio y PnL realizado
bot/src/microbot/broker.py     paper broker y adaptador live
bot/src/microbot/storage.py    DuckDB y exportación Parquet
bot/src/microbot/ws.py         WebSocket y reconexión
bot/src/microbot/main.py       orquestación
bot/src/microbot/train.py      entrenamiento del modelo base (split por mercado, walk-forward)
bot/src/microbot/evaluate.py   replay de la estrategia con escenarios pesimistas
bot/src/microbot/resolver.py   resolución oficial y liquidación 0/1
bot/src/microbot/ledger.py     equity, drawdown y exposición
bot/src/microbot/markets.py    mercados de Gamma, resoluciones y comisiones
bot/src/microbot/mcp_server.py servidor MCP de analítica (solo lectura; stdio o HTTP)
bot/src/microbot/mcp_auth.py   OAuth de un usuario para el MCP remoto
deploy/                        Caddy y systemd para mcp.midominio.com
dashboard/                     app Next.js (en vivo, libro L2, datos, entrenamiento, evaluación, control)
```
