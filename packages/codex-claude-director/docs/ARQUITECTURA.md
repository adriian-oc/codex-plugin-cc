# Arquitectura

## Por qué un paquete independiente dentro del fork

`openai/codex-plugin-cc` resuelve la dirección contraria (Claude Code → Codex) y no tiene dependencias de ejecución. Esta ampliación vive aparte, en `packages/codex-claude-director/`:

- no modifica el plugin original, que se sigue instalando y usando igual;
- tiene su propia suite de tests y su propia configuración;
- también carece de dependencias npm de ejecución (solo usa la biblioteca estándar de Node ≥ 20), con lo que se reduce la superficie de la cadena de suministro;
- se puede extraer a otro repositorio sin tocar el plugin.

## Componentes

| Archivo | Responsabilidad |
|---|---|
| `src/mcp-server.mjs` | Servidor MCP por stdio (JSON-RPC, ciclo `initialize`, `tools/list`, `tools/call`). Responde «method not found» a `server/discover` para que los clientes de la revisión 2026-07-28 vuelvan a `initialize` |
| `src/tools.mjs` | Catálogo de herramientas, validación de argumentos y resultados con `structuredContent` |
| `src/orchestrator.mjs` | Ciclo de vida de las tareas, admisión, ejecuciones de Claude, checks, revisión y recuperación |
| `src/capacity.mjs` | Lecturas de capacidad (procedencia, frescura, fiabilidad) y adaptadores oficiales de Codex y Claude |
| `src/ledger.mjs` | Libro de reservas compartido por cuenta y bloqueos por ruta |
| `src/policy.mjs` | Política de reparto: `delegate_claude`, `codex_direct`, `wait` o `refuse` |
| `src/git.mjs` | Worktrees, hash exacto del árbol (incluye archivos nuevos y borrados, sin tocar el índice real) y diff binario completo |
| `src/runner.mjs` | Supervisor desacoplado: límite de tiempo y de salida, cancelación de todo el grupo de procesos y registro de salida |
| `src/process-control.mjs` | Arranque de runners y verificación de identidad del PID (nonce en `argv` y hora de inicio) |
| `src/claude-worker.mjs` | Argumentos de `claude -p`, prompts mínimos y análisis del stream-json |
| `src/checks.mjs`, `src/check-sequence.mjs` | Checks declarados (`argv`, sin shell) leídos del commit base |
| `src/security.mjs` | Limpieza del entorno (variables de facturación por API y secretos) y redacción de credenciales |

## Estado

`~/.codex-claude-director/` (o `CCD_HOME`), con permisos `0700`/`0600`:

- `config.json`: configuración.
- `ledger.json`: reservas y bloqueos por ruta de **todos** los proyectos, protegidos por un bloqueo entre procesos.
- `telemetry/observations.json`: última lectura por proveedor y ventana, más un historial.
- `tasks/<id>/task.json`, `events.jsonl`, `runs/<run>/{stdout.jsonl,stderr.log,exit.json,runner.json}`, `checks/…`, `diffs/<tree>.patch`.
- `worktrees/<repoKey>/<id>/`: worktree de cada tarea, en la rama `ccd/<id>`.

## Estados de una tarea

`created → (queued | waiting_capacity) → ready → running → pending_review ⇄ checks_running → (accepted | changes_requested → running …) `

Además: `implementing_direct` (Codex implementa él mismo), `interrupted` (límite de uso, tiempo, turnos, respuesta incompleta o runner perdido; se puede reanudar), `blocked` (autenticación, facturación, worker bloqueado o rondas agotadas), `failed` (rechazada) y `cancelled`. Solo `accepted` significa terminada.

## Garantías y límites

| Aspecto | Qué garantiza | Qué **no** garantiza |
|---|---|---|
| Reservas | Ninguna admisión concurrente (de cualquier proyecto ni de ningún proceso del mismo usuario) reserva dos veces la misma capacidad registrada | El consumo real futuro ni el que hagas fuera del coordinador |
| Cuota desconocida | Nunca cuenta como disponible (política `deny`) | — |
| Revisión | La aceptación queda ligada al hash del árbol, exige checks superados en ese mismo árbol y se invalida si cambia algo | Que la revisión de Codex sea correcta en lo funcional |
| Aislamiento | Ramas y worktrees separados, bloqueos por ruta y ninguna modificación del checkout del usuario | **Un worktree no es un sandbox.** Claude ejecuta Bash con el sandbox de Claude Code (Seatbelt en macOS) si está disponible. Los checks se ejecutan **sin sandbox**, con tus permisos y con el entorno limpio de secretos |
| Bucles | Los workers se lanzan sin servidores MCP (`--strict-mcp-config`), con `mcp__*` y `Bash(codex *)` denegados, sin plugins ni hooks de usuario (`--setting-sources project,local`) y con una marca de entorno que impide delegar | Hooks maliciosos dentro de la propia configuración del proyecto (`.claude/settings.json` del repositorio) |
| Permisos | `--permission-mode dontAsk` con lista explícita de herramientas; nunca `bypassPermissions` | — |
| Procesos | Límite de duración y de salida, cancelación del grupo completo y PIDs verificados antes de enviar señales | Procesos que un comando lance con `setsid` para escapar de su grupo |
| Instrucciones | Los informes de los workers se devuelven marcados como `untrusted` y nunca alteran el estado del coordinador | Que Codex los ignore: depende de sus instrucciones (`AGENTS.md`) |

## Fuentes oficiales verificadas (03-10-2026)

- Claude Code, modo programático: <https://code.claude.com/docs/en/headless>. `-p`, `--output-format stream-json`, `--resume`/`--session-id`, `--permission-mode dontAsk`, `--json-schema`. **`--bare` no usa la suscripción** (necesita `ANTHROPIC_API_KEY`), por eso no se utiliza.
- Referencia de la CLI: <https://code.claude.com/docs/en/cli-reference>. `--allowedTools`, `--disallowedTools`, `--strict-mcp-config`, `--setting-sources`, `--max-turns`, `claude auth status` (`authMethod`).
- Tipos del Agent SDK (`@anthropic-ai/claude-agent-sdk` 0.3.288, `sdk.d.ts`): `SDKRateLimitEvent { rate_limit_info: { status, resetsAt, rateLimitType, utilization? } }`, `SDKResultMessage` (`usage`, `modelUsage.contextWindow`, `total_cost_usd`, `permission_denials`). `usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET` existe, pero **no se usa** porque es inestable.
- Barra de estado: <https://code.claude.com/docs/en/statusline>. `rate_limits.five_hour/seven_day.used_percentage` y `resets_at`, solo para Pro/Max y en sesiones interactivas.
- `claude mcp serve` expone **las herramientas** de Claude Code, no su bucle de agente (<https://code.claude.com/docs/en/mcp>). Por eso no sirve para delegar en Claude.
- Facturación: <https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan>. Cambio en pausa: `claude -p` consume los límites de la suscripción.
- Codex y MCP: <https://developers.openai.com/codex/mcp>. `[mcp_servers.<nombre>]` con `command`, `args`, `env`, `startup_timeout_sec`, `tool_timeout_sec` y `enabled`.
- Codex app-server: esquema generado por `codex app-server generate-ts` (codex-cli 0.160.0): `account/rateLimits/read` → `RateLimitSnapshot { primary, secondary: { usedPercent, windowDurationMins, resetsAt } }`. La documentación califica el app-server de experimental para cargas de producción.
- MCP: <https://modelcontextprotocol.io/specification/latest>. Las revisiones heredadas (≤ 2025-11-25) usan `initialize`; los clientes «dual-era» prueban `server/discover` y, si falla, vuelven a `initialize`.
