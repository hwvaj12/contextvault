#!/bin/sh
set -eu
: "${CV_API_URL:?Set the API origin reachable on CV_CLIENT_NETWORK}"
: "${CV_API_KEY:?Set a scoped credential in the environment}"
: "${CV_WORKSPACE_ID:?Set the workspace identifier}"
: "${CV_CLIENT_NETWORK:?Set the API-only client network}"
: "${CV_CLIENT_IMAGE:?Build the supplied client Dockerfile}"
: "${AGENT_IMAGE:?Set your existing agent image}"
test "$#" -gt 0
interval=${CV_HEARTBEAT_SECONDS:-10}
node -e 'const value=Number(process.argv[1]);if(!Number.isFinite(value)||value<0.01||value>120)process.exit(2)' "$interval"
parent=$(mktemp -d "${TMPDIR:-/tmp}/contextvault-agent.XXXXXXXX")
chmod 700 "$parent"
run_id=${CV_CONTAINER_RUN_ID:-$(node -p 'require("node:crypto").randomUUID()')}
node -e 'if(!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(process.argv[1]))process.exit(2)' "$run_id"
node -e 'console.log(JSON.stringify({clientStateParent:process.argv[1],containerRunId:process.argv[2]}))' "$parent" "$run_id"
client() {
  docker run --rm --user "$(id -u):$(id -g)" --label "io.contextvault.agent-run=$run_id" --network "$CV_CLIENT_NETWORK" --mount "type=bind,src=$parent,dst=/client" \
    --env CV_API_URL --env CV_API_KEY "$CV_CLIENT_IMAGE" "$@"
}
handle=$(client open --workspace "$CV_WORKSPACE_ID" --state-dir /client/session \
  --agent-label existing-container-agent --task owner-requested-task --reason ordinary-workspace-access)
printf '%s\n' "$handle"
workspace=$(printf '%s' "$handle" | node -e 'let text="";process.stdin.on("data",b=>text+=b);process.stdin.on("end",()=>{const value=JSON.parse(text);if(!value.ok||!value.workspace.path.startsWith("/client/"))process.exit(1);process.stdout.write(value.workspace.path)})')
relative=${workspace#/client/}
agent_name="cv-existing-agent-$run_id"
retained() { printf 'Agent stopped without completion. Retained client state: %s/session/state.json\n' "$parent" >&2; }
stop_agent() { docker stop --time 2 "$agent_name" >/dev/null 2>&1 || true; }
(
  set +e
  docker run --rm --name "$agent_name" --user "$(id -u):$(id -g)" --label "io.contextvault.agent-run=$run_id" --network "${AGENT_NETWORK:-none}" --mount "type=bind,src=$parent/$relative,dst=/workspace" --workdir /workspace "$AGENT_IMAGE" "$@"
  result=$?
  printf '%s\n' "$result" > "$parent/agent-exit"
) &
agent_pid=$!
trap 'stop_agent; wait "$agent_pid" || true; retained; exit 1' HUP INT TERM
while test ! -f "$parent/agent-exit"; do
  sleep "$interval"
  test ! -f "$parent/agent-exit" || break
  if ! client heartbeat --session /client/session; then
    stop_agent
    wait "$agent_pid" || true
    retained
    exit 1
  fi
done
wait "$agent_pid"
trap - HUP INT TERM
if test "$(cat "$parent/agent-exit")" = 0; then
  client finalize --session /client/session --writers-stopped
  client cleanup --session /client/session --writers-stopped
else
  retained
  exit 1
fi
printf 'Retained completion receipt: %s/session/state.json\n' "$parent"
