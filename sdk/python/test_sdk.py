"""Historical test entry point; delegate to the installed-wheel acceptance suite.

Use the repository's documented task-local test environment and explicit LocalStack
settings. The harness runs installed Python 3.8 consumers against both backends.
"""
from pathlib import Path
import subprocess
import sys


if __name__ == "__main__":
    repository = Path(__file__).resolve().parents[2]
    raise SystemExit(subprocess.call([sys.executable, "-m", "pytest", "tests/sdk/python"], cwd=str(repository)))
