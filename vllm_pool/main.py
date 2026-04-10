from __future__ import annotations
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from fastapi.responses import HTMLResponse
from .utils.logging import setup_logging
from .core.pool import PoolManager
from .core.ui_state_store import UIStateStore
from .core.config import DEFAULT_CFG_STR
from .api import router_start, router_status, router_generate, router_events, router_ui_state

# NEW robust paths
from pathlib import Path

def create_app() -> FastAPI:
    setup_logging()
    app = FastAPI(title="vLLM Pool", version="0.8.0")

    pool = PoolManager(max_workers=4)
    app.state.pool = pool
    ui_state_store = UIStateStore()
    app.state.ui_state_store = ui_state_store

    app.include_router(router_start.bind(pool))
    app.include_router(router_status.bind(pool))
    app.include_router(router_generate.bind(pool))
    app.include_router(router_events.bind(pool))
    app.include_router(router_ui_state.bind(ui_state_store))

    base_dir = Path(__file__).parent
    app.mount("/static", StaticFiles(directory=base_dir / "ui" / "static"), name="static")

    @app.get("/", response_class=HTMLResponse)
    def index():
        tpl = (base_dir / "ui" / "templates" / "index.html").read_text(encoding="utf-8")
        return HTMLResponse(tpl.replace("__DEFAULT_CFG__", DEFAULT_CFG_STR))

    return app

app = create_app()

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("vllm_pool.main:app", host="0.0.0.0", port=8000, reload=False)
