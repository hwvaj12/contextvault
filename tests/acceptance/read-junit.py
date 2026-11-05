"""Read local trusted reporter output without adding a JavaScript XML dependency."""
import json
from pathlib import Path
import sys
import xml.etree.ElementTree as ET

report = Path(sys.argv[1])
if not report.is_file() or report.is_symlink() or report.stat().st_size > 32 * 1024 * 1024:
    raise ValueError("JUnit report is missing or invalid")
root = ET.parse(report).getroot()
if root.tag not in ("testsuites", "testsuite"):
    raise ValueError("JUnit report has an invalid root")
cases = list(root.iter("testcase"))
if not cases:
    raise ValueError("JUnit report contains zero tests")
for suite in root.iter("testsuite"):
    children = list(suite.iter("testcase"))
    if "tests" not in suite.attrib or int(suite.attrib["tests"]) != len(children):
        raise ValueError("JUnit report has inconsistent test coverage")
    for name in ("failures", "errors", "skipped", "disabled"):
        if int(suite.attrib.get(name, "0")) != 0:
            raise ValueError("JUnit report contains failures or skips")
for case in cases:
    if not case.attrib.get("name") or any(case.find(name) is not None for name in ("failure", "error", "skipped")):
        raise ValueError("JUnit report contains invalid, failed, or skipped tests")
print(json.dumps({"tests": len(cases), "skipped": 0,
                  "names": [case.attrib["name"] for case in cases],
                  "classes": [case.attrib.get("classname", "") for case in cases]}))
