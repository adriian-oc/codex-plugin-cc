# codex-claude-director (extensión no oficial)

> **Aviso.** Es un desarrollo independiente que parte del repositorio `openai/codex-plugin-cc` (Apache-2.0). **No es un producto oficial de OpenAI ni de Anthropic**, y ninguna de las dos empresas lo respalda. El plugin original (`plugins/codex`), que sirve para usar Codex desde Claude Code, sigue intacto y funciona igual que antes.

## Qué hace

Tú hablas con **Codex**. Codex dirige el proyecto y, cuando conviene, delega tareas acotadas de programación en **Claude Code** a través de un servidor MCP local. Claude implementa en un worktree de Git separado. Después Codex inspecciona el diff exacto, ejecuta las comprobaciones autorizadas, revisa el trabajo y pide correcciones (con un número limitado de rondas) o lo acepta. Una tarea solo se considera terminada cuando la acepta una revisión vinculada a la versión exacta de los archivos.

```
Tú ──► Codex (director) ──MCP──► coordinador local ──► claude -p (worker, worktree aislado)
                 ▲                     │  reservas de capacidad compartidas
                 └── diff, checks, ────┘  estado persistente y recuperación
                     revisión, correcciones
```

Puntos clave:

- **Capacidad.** Antes de admitir una tarea, el coordinador reserva cuota para la implementación, la revisión de Codex, las comprobaciones, las rondas de corrección y el informe final. Las reservas viven en un libro compartido por todos los proyectos de la misma cuenta. Una cuota desconocida **no** cuenta como disponible.
- **Aislamiento.** Cada tarea trabaja en su propia rama `ccd/<tarea>` y su propio worktree. Hay bloqueos por ruta para que dos agentes no editen lo mismo a la vez. Nada se fusiona, se sube ni se despliega automáticamente.
- **Revisión vinculada.** La aceptación se refiere al *hash del árbol* exacto. Si después cambia cualquier archivo, la aceptación queda invalidada. Si un check modifica archivos, la versión que se revisa es la resultante.
- **Recuperación.** Hay checkpoints en Git y estado en disco. Las sesiones de Claude se reanudan con `--resume` sin reenviar todo el historial. Antes de enviar una señal a un PID se verifica que sigue perteneciendo al proceso correcto.

## Herramientas MCP para Codex

| Herramienta | Uso |
|---|---|
| `capacity_status` | Lecturas de cuota (procedencia, antigüedad, reinicio, fiabilidad), reservas y margen disponible |
| `capacity_record_manual` | Registrar un porcentaje leído de `/usage` (Claude) o `/status` (Codex) |
| `plan_task` | Explicar el reparto (`delegate_claude`, `codex_direct` o `wait`) sin efectos secundarios |
| `task_create` | Crear la tarea, reservar capacidad, crear el worktree y arrancar Claude si procede |
| `task_status` | Estado y siguiente paso; sin `taskId`, lista priorizada de tareas |
| `task_result` | Archivos añadidos, modificados y eliminados, fichero `.patch` completo, árbol exacto e informe del worker (no fiable) |
| `task_run_checks` | Ejecutar solo los checks declarados en la configuración de confianza |
| `task_review` | Aceptar, pedir cambios o rechazar una versión exacta |
| `task_request_fix` | Abrir una ronda de corrección (por Claude o por Codex), con el máximo configurado |
| `task_resume` / `task_cancel` | Reanudar tras una interrupción o un límite de uso / cancelar el proceso y todos sus hijos |
| `task_finalize_direct` | Cerrar una implementación hecha directamente por Codex (queda como *autorrevisión*) |
| `task_request_independent_review` | Revisión consultiva de solo lectura hecha por Claude |
| `task_cleanup`, `coordinator_doctor` | Limpieza y diagnóstico |

## Instalación

Consulta [docs/INSTALACION-macOS.md](docs/INSTALACION-macOS.md).

## Documentación

- [docs/INSTALACION-macOS.md](docs/INSTALACION-macOS.md): requisitos, instalación, conexión con Codex, autenticación, cuotas, checks por proyecto, primer encargo, recuperación y desinstalación.
- [docs/ARQUITECTURA.md](docs/ARQUITECTURA.md): diseño, garantías y límites, fuentes oficiales consultadas.
- [docs/EVALUACION.md](docs/EVALUACION.md): comparación de alternativas y mejoras priorizadas.
- [examples/AGENTS.md](examples/AGENTS.md): instrucciones para que Codex actúe como director.

## Pruebas

```bash
npm test                 # suite simulada (Claude falso, sin consumo real)
node scripts/real-smoke.mjs   # prueba REAL pequeña con tu Claude Code autenticado (consume cuota)
```

## Licencia

Apache-2.0, igual que el repositorio original. Consulta `NOTICE`.
