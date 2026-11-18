@echo off
setlocal DisableDelayedExpansion
pushd "%~dp0.." || exit /b 1

set "freefieldBranch="
for /f "delims=" %%B in ('git symbolic-ref --quiet HEAD') do set "freefieldBranch=%%B"
setlocal EnableDelayedExpansion
if not "!freefieldBranch!"=="refs/heads/main" (
    >&2 echo Switch to the main branch before updating.
    goto :failed
)

git diff --quiet -- || goto :dirty
git diff --cached --quiet -- || goto :dirty

git fetch origin main || goto :failed
git fetch upstream main || goto :failed
git merge --ff-only origin/main || goto :failed
git merge --ff --no-edit upstream/main || goto :failed
git push origin main || goto :failed

echo Freefield is up to date on your fork.
popd
exit /b 0

:dirty
>&2 echo Commit or stash your tracked changes before updating.

:failed
>&2 echo Update stopped. See the Git output above.
popd
exit /b 1
