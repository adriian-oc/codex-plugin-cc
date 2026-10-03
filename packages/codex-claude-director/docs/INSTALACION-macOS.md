# Instalación y uso en macOS

## 1. Requisitos

- macOS con Git (`xcode-select --install` si no lo tienes).
- Node.js 20 o posterior (`brew install node`).
- Codex CLI: `npm install -g @openai/codex` (o `brew install codex`).
- Claude Code: sigue el método de instalación oficial (`claude --version` debe responder).
- Ninguna dependencia npm adicional: el coordinador solo usa la biblioteca estándar de Node.

## 2. Autenticación (separada en cada herramienta)

```bash
codex login              # con tu cuenta de ChatGPT
claude auth login        # con tu suscripción de claude.ai (no con --console)
claude auth status       # debe mostrar "authMethod": "claude.ai"
```

El coordinador **no lee ni copia credenciales**. Cada CLI usa su propio inicio de sesión (en macOS, el llavero).

**Facturación.** Si Claude Code está autenticado con una clave de API (`authMethod: "api_key"`) o si `ANTHROPIC_API_KEY` está definida, el uso se cobraría como API. El coordinador elimina `ANTHROPIC_API_KEY` del entorno de los workers y se niega a lanzar Claude si el método de autenticación no es una suscripción, salvo que pongas `"claude": { "allowApiBilling": true }` en la configuración. No activa nunca consumo adicional ni cambios de plan.

Según el artículo de ayuda de Anthropic «Use the Claude Agent SDK with your Claude plan» (actualizado el 16-06-2026), el cambio anunciado para separar el uso de `claude -p` del plan quedó **en pausa**: por ahora `claude -p` consume los mismos límites de tu suscripción. Anthropic ha dicho que avisará antes de cambiarlo, así que conviene revisarlo de vez en cuando.

## 3. Instalación

```bash
git clone https://github.com/adriian-oc/codex-plugin-cc.git
cd codex-plugin-cc
git checkout feat/codex-director-claude-worker
cd packages/codex-claude-director
npm test                                   # opcional: suite simulada (~30 s)
node bin/ccd.mjs install --dry-run         # muestra el bloque que añadiría a ~/.codex/config.toml
node bin/ccd.mjs install --with-statusline # instala de verdad
```

`install` hace lo siguiente:

1. Crea `~/.codex-claude-director/config.json` (o lo fusiona si ya existe) y fija las rutas absolutas de `claude` y `codex`.
2. Añade a `~/.codex/config.toml` un bloque **delimitado por marcadores**, después de hacer una copia de seguridad (`config.toml.bak-ccd-<fecha>`). El resto del archivo no se toca. Si ya existe un `[mcp_servers.claude_director]` fuera de los marcadores, se detiene sin modificar nada.
3. Con `--with-statusline`, conecta el puente de la barra de estado de Claude Code (ver el punto 5). Si ya tenías una barra de estado propia, se conserva y se sigue ejecutando.

Comprobación:

```bash
codex mcp list                 # debe aparecer claude_director
node bin/ccd.mjs doctor        # binarios, autenticación, modo de facturación y puente
```

Dentro de Codex, `/mcp` muestra las herramientas disponibles.

Copia también [examples/AGENTS.md](../examples/AGENTS.md) en `~/.codex/AGENTS.md` (para todos tus proyectos) o en el `AGENTS.md` de cada proyecto.

## 4. Configuración por proyecto (checks autorizados)

Añade y **haz commit** de un `.codex-claude-director.json` en la raíz del repositorio (tienes un ejemplo en `examples/`):

```json
{
  "checks": [{ "name": "unit", "argv": ["npm", "test"], "timeoutSec": 600 }],
  "claudeAllowedBash": ["Bash(npm test)", "Bash(npm test *)"],
  "defaultScope": ["src", "test"]
}
```

- Los comandos son listas `argv`; nunca se interpretan en un shell.
- El archivo se lee del **commit base** de la tarea. Un worker no puede cambiar qué checks se ejecutan, y si modifica el archivo, la aceptación queda bloqueada.
- `claudeAllowedBash` amplía los comandos que Claude puede ejecutar sin preguntar (por ejemplo, para lanzar los tests él mismo).
- Alternativa sin tocar el repositorio: `~/.codex-claude-director/projects/<repoKey>.json` (el `repoKey` aparece en los mensajes del coordinador).

## 5. Cuotas y reservas

Las lecturas de capacidad salen de tres fuentes, siempre etiquetadas:

| Proveedor | Fuente | Procedencia | Automática |
|---|---|---|---|
| Codex | `codex app-server` → `account/rateLimits/read` (ventanas de 5 h y semanal, % usado y reinicio) | oficial | Sí, bajo demanda (no lanza ningún turno de modelo) |
| Claude | `rate_limit_event` en la salida stream-json de cada worker | oficial | Solo mientras corre un worker. A veces llega solo el estado (`allowed`), sin porcentaje |
| Claude | Puente de barra de estado (campos documentados `rate_limits.five_hour/seven_day`) | oficial | Solo mientras usas Claude Code de forma **interactiva** (planes Pro/Max) |
| Ambos | `node bin/ccd.mjs capacity set --provider claude --window five_hour --used 35` o la herramienta `capacity_record_manual` | manual | No |

**Limitación de Claude.** En el modo programático (`claude -p`), Claude Code no ofrece ninguna consulta documentada y estable del porcentaje restante. La API `usage_EXPERIMENTAL…` del SDK está marcada explícitamente como inestable, así que no se usa. Por eso no hay monitorización continua garantizada de Claude. Para que Codex pueda delegar sin lecturas recientes de Claude, hace falta una de estas tres cosas:

1. que hayas usado Claude Code de forma interactiva hace poco (con el puente instalado);
2. que registres a mano el dato de `/usage` (dentro de `claude`) o de la página de uso de claude.ai;
3. que actives explícitamente `"telemetry": { "unknownPolicy": "assume_used", "assumeUsedPct": 80 }` (supone un 80 % usado; es conservador, pero sigue siendo una suposición).

Con la política por defecto (`deny`), si la cuota de Claude es desconocida, Codex implementa directamente o espera.

Parámetros en `~/.codex-claude-director/config.json`:

- `telemetry.ttlSec` / `maxAgeSec`: cuándo una lectura deja de ser fresca y cuándo se descarta. Mientras está degradada, se le suma `stalePenaltyPct`.
- `safetyMarginPct`: margen que nunca se reserva.
- `estimates`: **estimaciones iniciales conservadoras**, en puntos porcentuales de cada ventana, por fase y tamaño (S/M/L). No son mediciones. Con `learning.enabled`, las muestras observadas dentro de cada ejecución solo pueden subir estas cifras, nunca bajarlas.
- `maxFixRounds` (2 por defecto; tope absoluto `maxFixRoundsHardCap` = 5).
- `claude.model`, `claude.maxTurns`, `claude.timeoutMin`, `claude.allowedTools`, `claude.disallowedTools`, `claude.sandbox`.

Las reservas reducen el riesgo de quedarse sin cuota, pero **no garantizan** el consumo futuro. Si usas Claude o Codex fuera del coordinador (otra ventana, el móvil…), ese consumo solo aparece en la siguiente lectura.

## 6. Primer encargo de ejemplo

En Codex, dentro de tu repositorio:

> Añade una función `slugify(texto)` en `src/text.js` con tests en `test/text.test.js`. Criterios: AC1 convierte a minúsculas y sustituye espacios por guiones; AC2 elimina los acentos; AC3 pasa `npm test`. Usa el coordinador `claude_director`: consulta la capacidad, delega en Claude si conviene, revisa el diff y los checks, y entrégame un resumen en español.

Codex debería encadenar `capacity_status` → `plan_task` → `task_create` → `task_status` → `task_result` → `task_run_checks` → `task_review`, y, si hace falta, `task_request_fix`. Al terminar, el trabajo queda en la rama `ccd/task_…`. Para revisarlo y fusionarlo tú:

```bash
git log ccd/task_xxxxxxxxxxxx
git merge --no-ff ccd/task_xxxxxxxxxxxx     # decisión tuya; el coordinador no fusiona
```

## 7. Recuperación después de una interrupción

- **Cierras Codex o reinicias el Mac.** Los workers siguen en segundo plano mientras el sistema esté encendido. Al volver, pide a Codex «usa `task_status` sin `taskId` y continúa las tareas pendientes». Las ejecuciones que se perdieron aparecen como `interrupted (runner_lost)`, con su trabajo guardado en un checkpoint.
- **Claude alcanza su límite.** La tarea pasa a `interrupted` con la hora de reinicio. `task_resume` la retoma en la misma sesión cuando hay cuota; también puedes pedir a Codex que termine él (`task_request_fix` con `by=codex`).
- **Codex se queda sin cuota.** Todo el estado está en disco (`~/.codex-claude-director/tasks/…`). Una nueva sesión de Codex continúa desde `task_status`.

## 8. Desactivar o desinstalar

```bash
node bin/ccd.mjs uninstall        # quita el bloque de config.toml y restaura tu barra de estado (con copia de seguridad)
```

Para desactivarlo temporalmente, añade `enabled = false` dentro del bloque `[mcp_servers.claude_director]`. El estado (`~/.codex-claude-director/`) y las ramas `ccd/*` no se borran automáticamente: elimínalos tú cuando ya no los necesites. Para quitar un worktree terminado: `task_cleanup` con `removeWorktree=true`, o `git worktree remove <ruta>`.

## Intervención humana que sigue siendo necesaria

- Iniciar sesión en cada CLI.
- Aportar la cuota de Claude cuando no haya lecturas recientes: usar Claude de forma interactiva con el puente instalado, o registrarla a mano.
- Fusionar o descartar las ramas `ccd/*`.
