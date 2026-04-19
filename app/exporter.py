import json
import logging
import os
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from . import database, settings

logger = logging.getLogger(__name__)

DATA_DIR = Path(os.environ.get("DATA_DIR", "/data"))
EXPORT_DIR = DATA_DIR / "static-export"
APP_STATIC = Path(__file__).parent / "static"
DEPLOY_KEY = Path(os.environ.get("CONFIG_DIR", "/config")) / "git_deploy_key"


def _git(*args, cwd: Path) -> subprocess.CompletedProcess:
    env = os.environ.copy()
    if DEPLOY_KEY.exists():
        env["GIT_SSH_COMMAND"] = f"ssh -i {DEPLOY_KEY} -o StrictHostKeyChecking=no"
    return subprocess.run(
        ["git"] + list(args),
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        timeout=60,
    )


def _ensure_git_repo(repo_url: str, branch: str) -> bool:
    """Init or pull the export directory as a git repo."""
    if not (EXPORT_DIR / ".git").exists():
        EXPORT_DIR.mkdir(parents=True, exist_ok=True)
        result = _git("clone", "--depth=1", "-b", branch, repo_url, ".", cwd=EXPORT_DIR)
        if result.returncode != 0:
            # Init fresh if clone fails (repo may be empty)
            _git("init", cwd=EXPORT_DIR)
            _git("remote", "add", "origin", repo_url, cwd=EXPORT_DIR)
            _git("checkout", "-b", branch, cwd=EXPORT_DIR)
            return True
    else:
        _git("fetch", "origin", cwd=EXPORT_DIR)
        _git("reset", "--hard", f"origin/{branch}", cwd=EXPORT_DIR)
    return True


def generate_static_site() -> None:
    cfg = settings.load()
    repo_url = cfg.get("git_repo_url", "")

    EXPORT_DIR.mkdir(parents=True, exist_ok=True)

    # Copy static assets
    for f in APP_STATIC.rglob("*"):
        if f.is_file():
            dest = EXPORT_DIR / f.relative_to(APP_STATIC)
            dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(f, dest)

    # Write data bundle
    data_dir = EXPORT_DIR / "data"
    data_dir.mkdir(exist_ok=True)

    cameras = database.get_cameras(active_only=False)
    (data_dir / "cameras.json").write_text(json.dumps(cameras, default=str))

    hourly = database.get_hourly_aggregates()
    (data_dir / "snapshots_aggregated.json").write_text(json.dumps(hourly, default=str))

    csv_data = database.export_csv()
    (data_dir / "snapshots_raw.csv").write_text(csv_data)

    # Write a flag so JS knows this is the static build (no SSE)
    (EXPORT_DIR / "static-build.json").write_text(json.dumps({"static": True}))

    logger.info("Static site written to %s", EXPORT_DIR)

    if not repo_url:
        logger.info("No git_repo_url configured — skipping push")
        return

    try:
        _ensure_git_repo(repo_url, cfg.get("git_remote_branch", "main"))
        _git("add", "-A", cwd=EXPORT_DIR)
        result = _git("diff", "--cached", "--quiet", cwd=EXPORT_DIR)
        if result.returncode == 0:
            logger.info("No changes to push")
            return
        ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        _git("commit", "-m", f"data: {ts}", cwd=EXPORT_DIR)
        push = _git("push", "origin", cfg.get("git_remote_branch", "main"), cwd=EXPORT_DIR)
        if push.returncode == 0:
            logger.info("Pushed static site to git")
        else:
            logger.error("Git push failed: %s", push.stderr)
    except Exception as e:
        logger.error("Export git push error: %s", e)


def generate_deploy_key() -> str:
    """Generate an ed25519 SSH key pair. Returns public key content."""
    config_dir = Path(os.environ.get("CONFIG_DIR", "/config"))
    key_path = config_dir / "git_deploy_key"
    key_path.parent.mkdir(parents=True, exist_ok=True)

    if key_path.exists():
        key_path.unlink()
    pub_path = Path(str(key_path) + ".pub")
    if pub_path.exists():
        pub_path.unlink()

    subprocess.run(
        ["ssh-keygen", "-t", "ed25519", "-f", str(key_path), "-N", "", "-C", "lynnwoodtraffic"],
        check=True, capture_output=True,
    )
    key_path.chmod(0o600)
    return pub_path.read_text().strip()
