# Evaluación de la arquitectura y mejoras

## Alternativas comparadas

| Opción | Fiabilidad | Consumo y latencia | Recuperación | Permisos | Mantenimiento | Experiencia desde Codex |
|---|---|---|---|---|---|---|
| **Servidor MCP local (elegida)** | Alta: estado en disco, bloqueos y runners desacoplados | Sin turnos de modelo adicionales. Cada llamada cuesta milisegundos; las tareas largas van en segundo plano | Buena: checkpoints, `--resume` y detección de runners perdidos | El coordinador fija los permisos de cada worker | Medio: ~2.000 líneas sin dependencias | Herramientas tipadas y resultados estructurados |
| Skill + CLI (Codex ejecuta `claude -p` en su shell) | Baja: Codex tiene que recordar el protocolo y el estado vive en la conversación | El historial de la conversación crece con las salidas | Mala tras cerrar Codex | Depende del sandbox de Codex y de lo que Codex escriba en cada orden | Bajo | Frágil y propensa a errores |
| `claude mcp serve` | — | — | — | Expone las **herramientas** de Claude, no su agente | — | No delega en Claude: **descartada** |
| Agent SDK de Claude (TypeScript) dentro del coordinador | Alta | Similar | Similar (`resume`) | `canUseTool` permite aprobar cada herramienta desde el coordinador | Añade una dependencia npm grande con muchas versiones | Igual que la elegida |
| Coordinador independiente (demonio) con adaptadores | Muy alta: cola continua y telemetría en segundo plano | El demonio consume recursos aunque no haya trabajo | Muy buena | Igual | Alto (servicio launchd, actualizaciones) | Igual, con planificación autónoma |
| Gestión por proyecto | Simple | — | — | — | Bajo | **Reserva dos veces** si hay varios proyectos con la misma cuenta: descartada |
| Gestión compartida por cuenta (elegida) | Evita las dobles reservas entre proyectos y sesiones | — | — | — | Un único libro con bloqueo | — |

**Conclusión.** Para una primera versión, el MCP local con libro compartido por cuenta es la opción más fiable y mantenible. El Agent SDK aportaría aprobación herramienta a herramienta (`canUseTool`), pero a cambio de una dependencia pesada. La CLI documentada (`claude -p` en stream-json) ya ofrece sesiones, eventos de límite, denegaciones y salida estructurada. Un demonio solo merece la pena si se necesita una cola que avance sin que Codex esté abierto.

## Problemas detectados y resueltos durante la implementación

1. **Carrera al romper bloqueos caducados.** La prueba de concurrencia (6 procesos y 2 proyectos) reservó una vez de más bajo carga. Causa: un proceso decidía que el bloqueo estaba abandonado basándose en un propietario que ya lo había liberado, y rompía el bloqueo nuevo de otro proceso. Solución: cada adquisición lleva un token, se vuelve a comprobar antes de romper el bloqueo (con `rename` atómico y devolución si cambió) y solo se libera la adquisición propia. Hay pruebas específicas.
2. **Falso «runner perdido»** cuando el runner terminaba entre dos lecturas. Ahora se vuelve a leer el registro de salida antes de declarar el runner perdido.
3. **Procesos zombi contados como vivos.** `pidAlive` los descarta.
4. Un evento `rate_limit_event` que solo trae el estado (`allowed`, sin porcentaje) **borraba** una lectura buena. Ahora se conserva como nota y no la sustituye.
5. Una reserva liberada dejaba de contarse antes de que la telemetría reflejara su consumo. Ahora queda como «consumida pendiente de observar» hasta que llega una lectura posterior.
6. `--bare` habría cambiado la facturación a una clave de API. No se usa, y además hay una protección explícita contra la facturación por API.

## Limitaciones pendientes (no resueltas)

- **Telemetría de Claude en modo programático.** No hay una consulta documentada y estable. Las lecturas automáticas solo llegan mientras corre un worker (`rate_limit_event`, a veces sin porcentaje) o mientras usas Claude Code de forma interactiva (puente de barra de estado). **No hay monitorización continua garantizada.** Además, la unidad de `utilization` no está documentada: se interpreta como fracción si es ≤ 1 y se marca con fiabilidad media.
- **Codex app-server.** El método `account/rateLimits/read` sale del esquema oficial generado por la CLI, pero OpenAI describe el app-server como experimental: puede cambiar.
- **Consumo de la propia conversación de Codex.** El coordinador no la ve. Solo conoce las ventanas de cuenta.
- **Estimaciones.** Las cifras iniciales son conjeturas conservadoras. El aprendizaje solo usa cambios de utilización observados dentro de una misma ejecución, y otras sesiones simultáneas pueden distorsionarlos.
- **Sandbox.** Los checks se ejecutan sin sandbox, con tus permisos y con el entorno limpio de secretos. El sandbox de Claude Code se aplica a su Bash si el sistema lo admite (en macOS, Seatbelt). Si no está disponible, Claude Code avisa y ejecuta sin él, salvo que configures `sandbox.failIfUnavailable`.
- **Hooks del proyecto.** `--setting-sources project,local` excluye los plugins y hooks del usuario, pero carga los del repositorio.

## Mejoras propuestas, priorizadas

1. **(Alta) Validación con cuentas reales en el Mac**: ejecutar `scripts/real-smoke.mjs` y un encargo desde Codex. Hay que confirmar el formato real de `rate_limit_event` (si trae `utilization` y en qué unidad) y ajustar el parser.
2. **(Alta) Sandbox para los checks en macOS**: ejecutarlos mediante el sandbox de Claude Code o un perfil `sandbox-exec` mínimo (escritura solo en el worktree, red desactivada), con una opción de exclusión explícita.
3. **(Media) Adaptador opcional de uso de Claude con el Agent SDK** (`usage_EXPERIMENTAL…`): desactivado por defecto, marcado como inestable y con su fecha de verificación.
4. **(Media) Cola persistente con prioridades**: hoy `task_resume` reintenta la admisión a petición. Un `queue_tick` podría admitir automáticamente la siguiente tarea `waiting_capacity` o `queued` por prioridad cuando se libere capacidad.
5. **(Media) Reservas por tokens/contexto**: decidir con `modelUsage.contextWindow` cuándo abrir una sesión nueva en lugar de reanudar, aprendiendo de `lastContextTokens`.
6. **(Baja) Demonio launchd opcional**: telemetría periódica de Codex y avance de la cola sin Codex abierto. Tiene coste propio (procesos y lecturas), así que solo compensa con mucho volumen.
7. **(Baja) Listas de revisión adaptadas de ECC (MIT)**: planner, code-reviewer, security-reviewer, tdd-guide y build-error-resolver como plantillas opcionales para `task_review`, con su atribución.
