# Validación económica de una versión candidata

Las pruebas de software verifican contabilidad y comportamiento. La rentabilidad requiere otro
experimento con datos capturados y ejecuciones plausibles. Este cambio no modifica los pesos de
la señal ni activa un modelo entrenado; la selección necesita evidencia fuera de muestra.

## Antes de comparar

1. Detener limpiamente el proceso y conservar una copia inmutable de los datos. Mantener la misma
   ventana de mercados, resoluciones, libro L2, metadatos de comisiones y latencia para las dos versiones.
2. Registrar commit, configuración, versión de features/modelo y periodo de cada experimento. No
   comparar directamente métricas de clasificación de horizontes o filtros de movimiento distintos.
3. Volver a arrancar solo en `record` o `paper`. Los controles diarios pueden pausar la nueva versión
   por pérdidas ya registradas ese día. No borrar el historial para ocultar el resultado.
4. Comprobar si mejoran la cadencia de captura y los huecos. La exportación completa pasa a un hilo
   con cursor propio; eso elimina un bloqueo del event loop, pero su efecto sobre la latencia del
   servidor debe medirse. No se ha demostrado que fuera la única causa de los huecos.

## Reproducir y entrenar

Desde `bot/`, con el entorno del proyecto activado:

```bash
python -m pytest -q
python -m ruff check .
python -m microbot.evaluate --data-dir data --fetch-resolutions --walk-forward
python -m microbot.train --features data/parquet/features.parquet --output data/candidate.joblib --metrics data/candidate-metrics.json --folds 4 --embargo-markets 5
```

Ejecutar la misma evaluación en el commit base y en el candidato contra la copia inmutable.
El replay comparte ahora las comisiones, los filtros de huecos y los controles de entrada del bot.
Los informes se guardan en `data/evaluations/`; el entrenamiento no activa el modelo en el bot.

La etiqueta actual selecciona movimientos y predice su dirección. Su probabilidad no es la
probabilidad de una operación ganadora ni la del pago final 0/1. No usarla como ventaja de precio,
ni para Kelly, sin un modelo económico que incluya movimientos pequeños, comisiones, spread,
latencia y distribución de los retornos. Diseñar esa etiqueta y su política como un experimento
separado, con nuevos bloques temporales reservados.

## Criterio de promoción

- Fijar la configuración en desarrollo y evaluar después mercados completos nunca usados para
  ajustar pesos, umbrales, calibración o límites. Mantener YES y NO juntos y purgar las etiquetas
  que alcancen el bloque siguiente. El holdout no sirve para elegir sucesivas variantes.
- Exigir PnL neto y expectativa positivos fuera de muestra bajo el escenario pesimista, con límite
  inferior del intervalo bootstrap por mercados mayor que cero. Una pausa que evita operar no
  demuestra rentabilidad. Revisar número de mercados y operaciones, semanas, concentración y
  regímenes, no solo el total agregado.
- Revisar drawdown, exposición, pérdidas de cola, fills parciales/rechazados y diferencia entre
  paper y replay. Valorar inventario pendiente con su resolución oficial o declararlo pendiente.
- Confirmar el resultado mediante paper prospectivo con la configuración congelada antes de
  considerar capital real. No aumentar tamaño para compensar una expectativa negativa.

El escenario `stress` informa sobre fragilidad; si no consigue fills, un PnL de cero no supera
el criterio. El adaptador live sigue necesitando recuperación completa de inventario al arrancar
y validación de restricciones del mercado. Un fallo de reconciliación detiene el bot y persiste
una marca que bloquea reinicios live hasta resolver el estado real.
