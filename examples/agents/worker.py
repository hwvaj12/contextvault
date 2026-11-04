"""Install the contextvault wheel in the application's normal environment."""
import json
import os
import re
import subprocess
import sys
import time
from contextvault import Client

argv = json.loads(os.environ['AGENT_COMMAND_JSON'])
if not isinstance(argv, list) or not argv or any(not isinstance(value, str) for value in argv):
    raise ValueError('AGENT_COMMAND_JSON must be an argument array')
client = Client(os.environ['CV_API_KEY'], os.environ['CV_API_URL'])
session = None
publication = None
try:
    options = dict(private_state_path=os.environ['CV_STATE_DIR'], local_parent=os.path.dirname(os.environ['CV_STATE_DIR']), agent_label=os.environ.get('AGENT_LABEL', 'existing-agent'), task=os.environ.get('AGENT_TASK', 'ordinary agent workspace'), reason=os.environ.get('AGENT_REASON', 'owner requested agent work'))
    session = client.open_workspace(os.environ['CV_WORKSPACE_ID'], **options) if os.environ.get('CV_WORKSPACE_ID') else client.create_workspace(os.environ['CV_CUSTOMER_ID'], os.environ.get('CV_WORKSPACE_NAME', 'agent-task'), **options)
    print(json.dumps(dict(stage='ready', path=session.path, privateStatePath=session.private_state_path, runId=session.run['id'])), flush=True)
    environment = dict(PATH=os.environ['PATH'], WORKSPACE_PATH=session.path)
    for name in filter(None, os.environ.get('AGENT_ENV_NAMES', '').split(',')):
        if not re.fullmatch(r'[A-Z_][A-Z0-9_]*', name) or name.startswith(('CV_', 'CONTEXTVAULT_', 'AWS_')):
            raise ValueError('Exclude ContextVault and storage credentials from agent environment names')
        if name in os.environ:
            environment[name] = os.environ[name]
    interval = float(os.environ.get('CV_HEARTBEAT_SECONDS', '10'))
    if not 0.01 <= interval <= 120:
        raise ValueError('Invalid heartbeat interval')
    agent = subprocess.Popen(argv, cwd=session.path, env=environment)
    next_heartbeat = time.monotonic() + interval
    try:
        while agent.poll() is None:
            if time.monotonic() >= next_heartbeat:
                session.heartbeat()
                next_heartbeat = time.monotonic() + interval
            time.sleep(min(0.05, interval))
    except Exception:
        agent.terminate()
        try:
            agent.wait(timeout=2)
        except subprocess.TimeoutExpired:
            agent.kill()
            agent.wait()
        raise
    if agent.returncode != 0:
        raise RuntimeError('Agent stopped without success; workspace retained for inspection')
    publication = session.finalize(writers_stopped=True)
    cleanup = session.cleanup(writers_stopped=True)
    print(json.dumps(dict(stage='complete', publication=publication, cleanupState=cleanup['state'], privateStatePath=session.private_state_path)), flush=True)
except Exception as error:
    print(json.dumps(dict(stage='retained', error=getattr(error, 'code', type(error).__name__), privateStatePath=getattr(error, 'private_state_path', None) or (session.private_state_path if session else None), publication=publication)), file=sys.stderr)
    sys.exit(1)
finally:
    client.close()
