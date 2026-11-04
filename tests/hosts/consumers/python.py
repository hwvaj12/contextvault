"""Executed using an installed wheel, never repository SDK imports."""
import importlib.metadata
import json
import os
import platform
from pathlib import Path
import signal
import socket
import subprocess
import sys
from urllib.request import Request, urlopen
from urllib.parse import urlsplit
import http.client
from contextvault import Client, OutcomeUnknownError

parent = Path(os.environ['CV_CLIENT_PARENT'])
handle_path = parent / 'handle.json'
first = bytes.fromhex('00ff6167656e740a')
second = bytes.fromhex('ff006e657874800a')

def agent(directory, stage):
    subprocess.run(['/bin/sh', str(Path(__file__).with_name('agent.sh')), str(directory), stage], check=True, env={'PATH': os.environ['PATH']})

def version(workspace):
    with urlopen(Request(os.environ['CV_API_URL'] + '/v1/workspaces/' + workspace, headers={'X-API-Key': os.environ['CV_API_KEY']}), timeout=5) as response:
        return json.load(response)['version']

def boundary():
    assert not any(name.startswith('AWS_') or name in ('CV_DATA_DIR', 'CV_S3_BUCKET', 'CV_S3_ENDPOINT') for name in os.environ)
    if os.environ['CV_BOUNDARY'] == 'worker':
        return dict(kind='cooperating-host-process')
    assert not Path(os.environ['CV_HOST_ONLY_FILE']).exists() and not Path('/var/run/docker.sock').exists()
    storage_probe = os.environ['CV_STORAGE_PROBE_REQUIRED'] == '1'
    if storage_probe:
        for host, port in [(os.environ['CV_STORAGE_PROBE_IP'], 4566), (os.environ['CV_STORAGE_PROBE_HOST_IP'], int(os.environ['CV_STORAGE_PROBE_HOST_PORT']))]:
            try:
                with socket.create_connection((host, port), timeout=0.7):
                    raise AssertionError('Canonical storage is directly reachable: ' + host)
            except OSError:
                pass
    origin = urlsplit(os.environ['CV_API_URL'])
    connection = http.client.HTTPConnection(origin.hostname, origin.port, timeout=2)
    try:
        connection.request('GET', 'http://' + os.environ['CV_STORAGE_PROBE_IP'] + ':4566/')
        response = connection.getresponse()
        assert response.status == 400
        response.read()
    finally:
        connection.close()
    return dict(kind='isolated-container-network', storageIpDenied=True if storage_probe else None, hostEndpointDenied=True if storage_probe else None, relayDestinationDenied=True, hostFilesystemDenied=True)

action = sys.argv[1]
if action == 'tamper':
    agent(json.loads(handle_path.read_text())['path'], 'tamper')
    print(json.dumps(dict(ok=True)))
    sys.exit(0)
isolation = boundary()
cv = Client(os.environ['CV_API_KEY'], os.environ['CV_API_URL'], poll_timeout=10)
if action == 'start':
    session = cv.create_workspace(os.environ['CV_CUSTOMER_ID'], 'host-python', private_state_path=str(parent / 'session'), local_parent=str(parent), agent_label='independent-shell-agent', task='host matrix', reason='client-local files')
    agent(session.path, 'first')
    try:
        session.checkpoint(writers_stopped=True)
        raise AssertionError('Expected lost response')
    except OutcomeUnknownError:
        pass
    state = json.loads((Path(session.private_state_path) / 'state.json').read_text())
    assert state['session']['pendingCommand']['idempotencyKey']
    assert (Path(session.path) / 'payload.bin').read_bytes() == first
    assert os.environ['CV_API_KEY'] not in json.dumps(state)
    saved = dict(privatePath=session.private_state_path, path=session.path, workspaceId=session.workspace_id, originalRunId=session.run['id'], originalKey=state['session']['pendingCommand']['idempotencyKey'])
    with handle_path.open('w') as output:
        json.dump(saved, output)
        output.flush()
        os.fsync(output.fileno())
    print(json.dumps(dict(phase='crash', **saved)), flush=True)
    os.kill(os.getpid(), signal.SIGKILL)
assert action == 'resume'
saved = json.loads(handle_path.read_text())
session = cv.resume_workspace(saved['privatePath'])
assert session.state['pendingCommand']['idempotencyKey'] == saved['originalKey']
session.reconcile()
assert version(saved['workspaceId']) == 2 and session.run['id'] != saved['originalRunId']
assert cv.runs.get(saved['originalRunId'])['state'] == 'finalized'
assert (Path(session.path) / 'payload.bin').read_bytes() == first
session.heartbeat()
agent(session.path, 'next')
session.finalize(writers_stopped=True)
old_path = session.path
session.cleanup(writers_stopped=True)
assert not Path(old_path).exists()
reader = cv.open_workspace(saved['workspaceId'], local_parent=str(parent), mode='read-only')
assert (Path(reader.path) / 'payload.bin').read_bytes() == second
assert (Path(reader.path) / 'empty').is_dir() and not (Path(reader.path) / 'delete-me.txt').exists()
assert (Path(reader.path) / 'café.txt').read_text() == 'unicode file\n'
reader.finalize(writers_stopped=True)
reader.cleanup(writers_stopped=True)
abort = cv.open_workspace(saved['workspaceId'], local_parent=str(parent))
agent(abort.path, 'abort')
old_path = abort.path
abort.abort('discard ordinary agent files', writers_stopped=True, cleanup=True)
assert not Path(old_path).exists() and version(saved['workspaceId']) == 3
print(json.dumps(dict(ok=True, language='python', runtime=sys.version.split()[0], os=platform.system() + '/' + platform.machine(), package=importlib.metadata.version('contextvault'), isolation=isolation, workspaceId=saved['workspaceId'], version=3, binaryDeletion=True, checkpoint=True, killedControllerRecovery=True, originalKey=saved['originalKey'], finalized=True, aborted=True, cleaned=True)))
cv.close()
