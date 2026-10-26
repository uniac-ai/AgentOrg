import socket
import threading
import time

import pytest
import uvicorn
from fastapi import Request

from agentorg.app import create_app
from agentorg.models import Ask, AskAnswer
from agentorg.operations import Caller
from agentorg.operations.service import Service
from agentorg.store import Store

TOKEN = "test-token"


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def auth():
    return {"Authorization": f"Bearer {TOKEN}"}


@pytest.fixture
def service(tmp_path):
    store = Store(tmp_path / "agentorg.db")
    yield Service(store, machine="laptop")
    store.close()


async def answer_as_the_page(request: Request, answer: AskAnswer) -> Ask:
    return await request.app.state.operations.ask_answer(answer, Caller(channel="page"))


@pytest.fixture
def server_url(service):
    """The base URL of a real server over `service`, stopped after the test.

    `POST /test/answer` stands in for the decisions page's answer route, which is where the user
    operation `ask_answer` is served.
    """
    app = create_app(service, token=TOKEN)
    app.add_api_route("/test/answer", answer_as_the_page, methods=["POST"])
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning"))
    thread = threading.Thread(target=server.run, daemon=True)
    thread.start()
    deadline = time.monotonic() + 10
    while not server.started:
        if time.monotonic() > deadline or not thread.is_alive():
            raise RuntimeError("the test server did not start")
        time.sleep(0.01)
    yield f"http://127.0.0.1:{port}"
    server.should_exit = True
    thread.join(timeout=10)
