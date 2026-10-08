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
virtualenv `bot/.bot` (o `bot/.venv`). Tiene tres secciones:

- **En vivo** (`/`): el bot en vivo o en modo reproducción (bid/ask/mid con las operaciones, score,
  equity/PnL y fills).
- **Datos** (`/data`): resumen de la recopilación (filas, sesiones, filas por minuto, estadísticas de
  features, preparación para entrenar y últimas filas).
- **Entrenamiento** (`/training`): lanza y detiene `microbot-train`, con historial, métricas,
  coeficientes y log. Cada ejecución se guarda en `bot/data/training/<id>/` (modelo, métricas y log) y
  entrena desde el Parquet exportado, así que funciona con el bot en marcha. Requiere `pip install -e '.[ml]'`.

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
pip install -e '.[ml]'
microbot-train --db data/microbot.duckdb --output data/model.joblib --horizon-seconds 15
```

Actívalo en `.env` y vuelve a ejecutar el bot:

```dotenv
PM_MODEL_PATH=data/model.joblib
```

El entrenador usa regresión logística. Etiqueta cada observación con el movimiento del midpoint
`--horizon-seconds` después, y solo cuenta movimientos mayores que medio spread más `--min-move`, es
decir, que cubrirían el coste de cruzar. La separación temporal 80/20 deja un embargo igual al horizonte
entre entrenamiento y test para que las etiquetas no se filtren. Solo usa filas con el conjunto de
features actual. El reporte muestra ROC-AUC, precision y recall fuera de muestra y la precisión en las
predicciones de alta confianza; eso todavía no equivale a rentabilidad.

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
- Envía órdenes FAK con límite `mejor precio ± PM_MAX_SLIPPAGE`. En paper, el fill recorre el libro y
  puede ser parcial; `fills.pnl` registra el PnL realizado de cada venta.

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

Los pesos y umbrales son un punto de partida, no parámetros optimizados.

## Pruebas

```bash
cd bot
pytest -q
ruff check .
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
bot/src/microbot/train.py      entrenamiento del modelo base
dashboard/                     app Next.js (en vivo, datos, entrenamiento, control del bot)
```
