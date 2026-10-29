$ErrorActionPreference = 'Stop'
$qqRoot = Split-Path -Parent $PSScriptRoot
$qqBasePython = (Get-Command python.exe -ErrorAction Stop).Source
$qqVenv = Join-Path $qqRoot '.venv'
$qqPython = Join-Path $qqVenv 'Scripts\python.exe'
& $qqBasePython -m venv --without-pip $qqVenv
if ($LASTEXITCODE -ne 0) { throw 'Failed to create Python environment.' }
& $qqBasePython -m pip --python $qqPython install -r (Join-Path $qqRoot 'python\requirements.lock.txt') --cache-dir (Join-Path $qqRoot '.pip-cache') --disable-pip-version-check
if ($LASTEXITCODE -ne 0) { throw 'Failed to install Python agent dependencies.' }
& $qqPython -c 'from langchain.agents import create_agent; from langchain_deepseek import ChatDeepSeek; print("Python LangChain agent ready")'
if ($LASTEXITCODE -ne 0) { throw 'Python agent import check failed.' }
