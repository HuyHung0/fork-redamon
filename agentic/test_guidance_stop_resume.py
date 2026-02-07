"""Tests for guidance, stop, and resume features in websocket_api.py.

Tests cover:
- WebSocketConnection guidance queue and drain
- GuidanceMessage model validation
- handle_guidance, handle_stop, handle_resume handlers
- Message routing for new types
- Background task pattern for handle_query
- Disconnect cleanup
"""

import asyncio
import json
import sys
import types
from datetime import datetime
from unittest.mock import AsyncMock, MagicMock, patch, PropertyMock

# ---------------------------------------------------------------------------
# Work around circular import: websocket_api → orchestrator_helpers → prompts
# → utils → orchestrator_helpers.  We pre-seed orchestrator_helpers so that
# `from orchestrator_helpers import create_config` succeeds without pulling
# in the full dependency chain.
# ---------------------------------------------------------------------------
_oh = types.ModuleType("orchestrator_helpers")
_oh.create_config = MagicMock(return_value={
    "recursion_limit": 500,
    "configurable": {
        "thread_id": "u:p:s",
        "user_id": "u",
        "project_id": "p",
        "session_id": "s",
    }
})
sys.modules.setdefault("orchestrator_helpers", _oh)

import pytest

from websocket_api import (
    MessageType,
    GuidanceMessage,
    WebSocketConnection,
    WebSocketManager,
    WebSocketHandler,
    StreamingCallback,
)


# =============================================================================
# FIXTURES
# =============================================================================

class FakeWebSocket:
    """Minimal fake WebSocket for testing."""

    def __init__(self):
        self.sent_messages = []
        self.client = "test-client"

    async def send_json(self, data):
        self.sent_messages.append(data)

    async def accept(self):
        pass

    async def close(self, code=1000, reason=""):
        pass


def make_connection(authenticated=True):
    """Create a test WebSocketConnection."""
    ws = FakeWebSocket()
    conn = WebSocketConnection(ws)
    if authenticated:
        conn.user_id = "test_user"
        conn.project_id = "test_project"
        conn.session_id = "test_session"
        conn.authenticated = True
    return conn


def make_handler(orchestrator=None):
    """Create a WebSocketHandler with mock orchestrator."""
    if orchestrator is None:
        orchestrator = MagicMock()
    ws_manager = WebSocketManager()
    return WebSocketHandler(orchestrator, ws_manager)


# =============================================================================
# TESTS: WebSocketConnection guidance queue
# =============================================================================

class TestWebSocketConnectionGuidance:
    """Tests for WebSocketConnection guidance queue management."""

    def test_guidance_queue_initialized(self):
        conn = make_connection()
        assert isinstance(conn.guidance_queue, asyncio.Queue)
        assert conn.guidance_queue.empty()

    def test_active_task_initialized(self):
        conn = make_connection()
        assert conn._active_task is None

    def test_is_stopped_initialized(self):
        conn = make_connection()
        assert conn._is_stopped is False

    @pytest.mark.asyncio
    async def test_drain_guidance_empty(self):
        conn = make_connection()
        result = conn.drain_guidance()
        assert result == []

    @pytest.mark.asyncio
    async def test_drain_guidance_with_messages(self):
        conn = make_connection()
        await conn.guidance_queue.put("focus on port 22")
        await conn.guidance_queue.put("skip the web server")

        result = conn.drain_guidance()
        assert result == ["focus on port 22", "skip the web server"]
        assert conn.guidance_queue.empty()

    @pytest.mark.asyncio
    async def test_drain_guidance_clears_queue(self):
        conn = make_connection()
        await conn.guidance_queue.put("msg1")
        await conn.guidance_queue.put("msg2")

        conn.drain_guidance()
        assert conn.guidance_queue.empty()
        assert conn.drain_guidance() == []


# =============================================================================
# TESTS: GuidanceMessage model
# =============================================================================

class TestGuidanceMessage:
    """Tests for GuidanceMessage Pydantic model."""

    def test_valid_guidance(self):
        msg = GuidanceMessage(message="focus on SSH")
        assert msg.message == "focus on SSH"

    def test_empty_message_allowed(self):
        msg = GuidanceMessage(message="")
        assert msg.message == ""

    def test_missing_message_raises(self):
        from pydantic import ValidationError
        with pytest.raises(ValidationError):
            GuidanceMessage()


# =============================================================================
# TESTS: handle_guidance
# =============================================================================

class TestHandleGuidance:
    """Tests for WebSocketHandler.handle_guidance."""

    @pytest.mark.asyncio
    async def test_guidance_queued(self):
        conn = make_connection()
        handler = make_handler()

        await handler.handle_guidance(conn, {"message": "focus on SSH"})

        assert not conn.guidance_queue.empty()
        msg = conn.guidance_queue.get_nowait()
        assert msg == "focus on SSH"

    @pytest.mark.asyncio
    async def test_guidance_sends_ack(self):
        conn = make_connection()
        handler = make_handler()

        await handler.handle_guidance(conn, {"message": "try port 443"})

        assert len(conn.websocket.sent_messages) == 1
        ack = conn.websocket.sent_messages[0]
        assert ack["type"] == MessageType.GUIDANCE_ACK.value
        assert ack["payload"]["message"] == "try port 443"
        assert ack["payload"]["queue_position"] == 1

    @pytest.mark.asyncio
    async def test_guidance_queue_position_increments(self):
        conn = make_connection()
        handler = make_handler()

        await handler.handle_guidance(conn, {"message": "msg1"})
        await handler.handle_guidance(conn, {"message": "msg2"})

        ack1 = conn.websocket.sent_messages[0]
        ack2 = conn.websocket.sent_messages[1]
        assert ack1["payload"]["queue_position"] == 1
        assert ack2["payload"]["queue_position"] == 2

    @pytest.mark.asyncio
    async def test_guidance_unauthenticated(self):
        conn = make_connection(authenticated=False)
        handler = make_handler()

        await handler.handle_guidance(conn, {"message": "test"})

        assert len(conn.websocket.sent_messages) == 1
        error = conn.websocket.sent_messages[0]
        assert error["type"] == MessageType.ERROR.value
        assert "Not authenticated" in error["payload"]["message"]
        assert conn.guidance_queue.empty()

    @pytest.mark.asyncio
    async def test_guidance_invalid_payload(self):
        conn = make_connection()
        handler = make_handler()

        await handler.handle_guidance(conn, {"wrong_field": "test"})

        assert len(conn.websocket.sent_messages) == 1
        error = conn.websocket.sent_messages[0]
        assert error["type"] == MessageType.ERROR.value
        assert "Invalid guidance format" in error["payload"]["message"]


# =============================================================================
# TESTS: handle_stop
# =============================================================================

class TestHandleStop:
    """Tests for WebSocketHandler.handle_stop."""

    @pytest.mark.asyncio
    async def test_stop_cancels_active_task(self):
        conn = make_connection()
        handler = make_handler()

        # Use MagicMock (not AsyncMock) — .done() is synchronous on asyncio.Task
        mock_task = MagicMock()
        mock_task.done.return_value = False
        conn._active_task = mock_task

        mock_state = MagicMock()
        mock_state.values = {"current_iteration": 3, "current_phase": "exploitation"}
        handler.orchestrator.graph = MagicMock()
        handler.orchestrator.graph.aget_state = AsyncMock(return_value=mock_state)

        await handler.handle_stop(conn, {})

        mock_task.cancel.assert_called_once()
        assert conn._is_stopped is True

    @pytest.mark.asyncio
    async def test_stop_sends_stopped_message(self):
        conn = make_connection()
        handler = make_handler()

        mock_task = MagicMock()
        mock_task.done.return_value = False
        conn._active_task = mock_task

        mock_state = MagicMock()
        mock_state.values = {"current_iteration": 5, "current_phase": "informational"}
        handler.orchestrator.graph = MagicMock()
        handler.orchestrator.graph.aget_state = AsyncMock(return_value=mock_state)

        await handler.handle_stop(conn, {})

        assert len(conn.websocket.sent_messages) == 1
        stopped = conn.websocket.sent_messages[0]
        assert stopped["type"] == MessageType.STOPPED.value
        assert stopped["payload"]["iteration"] == 5
        assert stopped["payload"]["phase"] == "informational"

    @pytest.mark.asyncio
    async def test_stop_no_active_task(self):
        conn = make_connection()
        handler = make_handler()
        conn._active_task = None

        await handler.handle_stop(conn, {})

        assert len(conn.websocket.sent_messages) == 1
        error = conn.websocket.sent_messages[0]
        assert error["type"] == MessageType.ERROR.value
        assert "No active execution to stop" in error["payload"]["message"]

    @pytest.mark.asyncio
    async def test_stop_task_already_done(self):
        conn = make_connection()
        handler = make_handler()

        mock_task = MagicMock()
        mock_task.done.return_value = True
        conn._active_task = mock_task

        await handler.handle_stop(conn, {})

        error = conn.websocket.sent_messages[0]
        assert error["type"] == MessageType.ERROR.value
        assert "No active execution to stop" in error["payload"]["message"]

    @pytest.mark.asyncio
    async def test_stop_unauthenticated(self):
        conn = make_connection(authenticated=False)
        handler = make_handler()

        await handler.handle_stop(conn, {})

        error = conn.websocket.sent_messages[0]
        assert error["type"] == MessageType.ERROR.value
        assert "Not authenticated" in error["payload"]["message"]

    @pytest.mark.asyncio
    async def test_stop_state_read_failure_uses_defaults(self):
        """When aget_state fails, stop should still work with default values."""
        conn = make_connection()
        handler = make_handler()

        mock_task = MagicMock()
        mock_task.done.return_value = False
        conn._active_task = mock_task

        handler.orchestrator.graph = MagicMock()
        handler.orchestrator.graph.aget_state = AsyncMock(side_effect=Exception("DB error"))

        await handler.handle_stop(conn, {})

        assert conn._is_stopped is True
        stopped = conn.websocket.sent_messages[0]
        assert stopped["type"] == MessageType.STOPPED.value
        assert stopped["payload"]["iteration"] == 0
        assert stopped["payload"]["phase"] == "informational"


# =============================================================================
# TESTS: handle_resume
# =============================================================================

class TestHandleResume:
    """Tests for WebSocketHandler.handle_resume."""

    @pytest.mark.asyncio
    async def test_resume_when_not_stopped(self):
        conn = make_connection()
        handler = make_handler()
        conn._is_stopped = False

        await handler.handle_resume(conn, {})

        error = conn.websocket.sent_messages[0]
        assert error["type"] == MessageType.ERROR.value
        assert "No stopped execution to resume" in error["payload"]["message"]

    @pytest.mark.asyncio
    async def test_resume_creates_task(self):
        conn = make_connection()
        handler = make_handler()
        conn._is_stopped = True

        handler.orchestrator.resume_execution_with_streaming = AsyncMock()

        await handler.handle_resume(conn, {})

        assert conn._is_stopped is False
        assert conn._active_task is not None

        conn._active_task.cancel()
        try:
            await conn._active_task
        except (asyncio.CancelledError, Exception):
            pass

    @pytest.mark.asyncio
    async def test_resume_unauthenticated(self):
        conn = make_connection(authenticated=False)
        handler = make_handler()
        conn._is_stopped = True

        await handler.handle_resume(conn, {})

        error = conn.websocket.sent_messages[0]
        assert error["type"] == MessageType.ERROR.value
        assert "Not authenticated" in error["payload"]["message"]


# =============================================================================
# TESTS: Message routing
# =============================================================================

class TestMessageRouting:
    """Tests for handle_message routing new message types."""

    @pytest.mark.asyncio
    async def test_route_guidance(self):
        conn = make_connection()
        handler = make_handler()

        msg = json.dumps({
            "type": "guidance",
            "payload": {"message": "try SSH"}
        })

        await handler.handle_message(conn, msg)

        assert not conn.guidance_queue.empty()
        ack = conn.websocket.sent_messages[0]
        assert ack["type"] == MessageType.GUIDANCE_ACK.value

    @pytest.mark.asyncio
    async def test_route_stop(self):
        conn = make_connection()
        handler = make_handler()
        conn._active_task = None

        msg = json.dumps({
            "type": "stop",
            "payload": {}
        })

        await handler.handle_message(conn, msg)

        error = conn.websocket.sent_messages[0]
        assert error["type"] == MessageType.ERROR.value

    @pytest.mark.asyncio
    async def test_route_resume(self):
        conn = make_connection()
        handler = make_handler()
        conn._is_stopped = False

        msg = json.dumps({
            "type": "resume",
            "payload": {}
        })

        await handler.handle_message(conn, msg)

        error = conn.websocket.sent_messages[0]
        assert error["type"] == MessageType.ERROR.value
        assert "No stopped execution to resume" in error["payload"]["message"]


# =============================================================================
# TESTS: Background task pattern (handle_query)
# =============================================================================

class TestBackgroundTaskPattern:
    """Tests for the background task pattern in handle_query."""

    @pytest.mark.asyncio
    async def test_query_creates_background_task(self):
        conn = make_connection()
        orchestrator = MagicMock()
        orchestrator.invoke_with_streaming = AsyncMock(return_value=MagicMock())
        handler = make_handler(orchestrator)

        await handler.handle_query(conn, {"question": "test query"})

        assert conn._active_task is not None
        assert conn._is_stopped is False

        conn._active_task.cancel()
        try:
            await conn._active_task
        except (asyncio.CancelledError, Exception):
            pass

    @pytest.mark.asyncio
    async def test_query_drains_stale_guidance(self):
        conn = make_connection()
        await conn.guidance_queue.put("old guidance from previous run")

        orchestrator = MagicMock()
        orchestrator.invoke_with_streaming = AsyncMock(return_value=MagicMock())
        handler = make_handler(orchestrator)

        await handler.handle_query(conn, {"question": "new query"})

        assert conn.guidance_queue.empty()

        if conn._active_task:
            conn._active_task.cancel()
            try:
                await conn._active_task
            except (asyncio.CancelledError, Exception):
                pass

    @pytest.mark.asyncio
    async def test_query_passes_guidance_queue(self):
        conn = make_connection()
        orchestrator = MagicMock()
        orchestrator.invoke_with_streaming = AsyncMock(return_value=MagicMock())
        handler = make_handler(orchestrator)

        await handler.handle_query(conn, {"question": "test"})
        await asyncio.sleep(0.05)

        call_args = orchestrator.invoke_with_streaming.call_args
        assert call_args is not None
        assert call_args.kwargs.get("guidance_queue") is conn.guidance_queue

        if conn._active_task:
            conn._active_task.cancel()
            try:
                await conn._active_task
            except (asyncio.CancelledError, Exception):
                pass

    @pytest.mark.asyncio
    async def test_query_unauthenticated(self):
        conn = make_connection(authenticated=False)
        handler = make_handler()

        await handler.handle_query(conn, {"question": "test"})

        error = conn.websocket.sent_messages[0]
        assert error["type"] == MessageType.ERROR.value
        assert "Not authenticated" in error["payload"]["message"]
        assert conn._active_task is None

    @pytest.mark.asyncio
    async def test_task_clears_on_completion(self):
        conn = make_connection()
        orchestrator = MagicMock()
        orchestrator.invoke_with_streaming = AsyncMock(return_value=MagicMock())
        handler = make_handler(orchestrator)

        await handler.handle_query(conn, {"question": "test"})

        if conn._active_task:
            await conn._active_task

        assert conn._active_task is None

    @pytest.mark.asyncio
    async def test_task_handles_cancellation(self):
        """Cancelled task should not send error, just log."""
        conn = make_connection()

        async def slow_invoke(**kwargs):
            await asyncio.sleep(10)

        orchestrator = MagicMock()
        orchestrator.invoke_with_streaming = slow_invoke
        handler = make_handler(orchestrator)

        await handler.handle_query(conn, {"question": "test"})

        assert conn._active_task is not None
        conn._active_task.cancel()

        try:
            await conn._active_task
        except asyncio.CancelledError:
            pass

        error_msgs = [m for m in conn.websocket.sent_messages if m["type"] == MessageType.ERROR.value]
        assert len(error_msgs) == 0

    @pytest.mark.asyncio
    async def test_task_handles_orchestrator_error(self):
        """Orchestrator exception should send ERROR to client."""
        conn = make_connection()
        orchestrator = MagicMock()
        orchestrator.invoke_with_streaming = AsyncMock(side_effect=RuntimeError("LLM failed"))
        handler = make_handler(orchestrator)

        await handler.handle_query(conn, {"question": "test"})

        if conn._active_task:
            await conn._active_task

        error_msgs = [m for m in conn.websocket.sent_messages if m["type"] == MessageType.ERROR.value]
        assert len(error_msgs) == 1
        assert "LLM failed" in error_msgs[0]["payload"]["message"]


# =============================================================================
# TESTS: MessageType enum values match frontend
# =============================================================================

class TestMessageTypeConsistency:
    """Verify new message types have correct string values."""

    def test_guidance_value(self):
        assert MessageType.GUIDANCE.value == "guidance"

    def test_stop_value(self):
        assert MessageType.STOP.value == "stop"

    def test_resume_value(self):
        assert MessageType.RESUME.value == "resume"

    def test_guidance_ack_value(self):
        assert MessageType.GUIDANCE_ACK.value == "guidance_ack"

    def test_stopped_value(self):
        assert MessageType.STOPPED.value == "stopped"


# =============================================================================
# TESTS: StreamingCallback (dedup still works)
# =============================================================================

class TestStreamingCallback:
    """Verify streaming callback deduplication still works."""

    @pytest.mark.asyncio
    async def test_response_dedup(self):
        conn = make_connection()
        cb = StreamingCallback(conn)

        await cb.on_response("answer1", 1, "informational", False)
        await cb.on_response("answer2", 2, "exploitation", True)

        response_msgs = [m for m in conn.websocket.sent_messages
                        if m["type"] == MessageType.RESPONSE.value]
        assert len(response_msgs) == 1
        assert response_msgs[0]["payload"]["answer"] == "answer1"

    @pytest.mark.asyncio
    async def test_task_complete_dedup(self):
        conn = make_connection()
        cb = StreamingCallback(conn)

        await cb.on_task_complete("done", "informational", 5)
        await cb.on_task_complete("done again", "exploitation", 10)

        tc_msgs = [m for m in conn.websocket.sent_messages
                   if m["type"] == MessageType.TASK_COMPLETE.value]
        assert len(tc_msgs) == 1


# =============================================================================
# TESTS: Approval/Answer background task pattern
# =============================================================================

class TestApprovalAnswerBackgroundTasks:
    """Test that approval and answer handlers also use background tasks."""

    @pytest.mark.asyncio
    async def test_approval_creates_task(self):
        conn = make_connection()
        orchestrator = MagicMock()
        orchestrator.resume_after_approval_with_streaming = AsyncMock(return_value=MagicMock())
        handler = make_handler(orchestrator)

        await handler.handle_approval(conn, {"decision": "approve"})

        assert conn._active_task is not None
        assert conn._is_stopped is False

        conn._active_task.cancel()
        try:
            await conn._active_task
        except (asyncio.CancelledError, Exception):
            pass

    @pytest.mark.asyncio
    async def test_answer_creates_task(self):
        conn = make_connection()
        orchestrator = MagicMock()
        orchestrator.resume_after_answer_with_streaming = AsyncMock(return_value=MagicMock())
        handler = make_handler(orchestrator)

        await handler.handle_answer(conn, {"answer": "yes"})

        assert conn._active_task is not None
        assert conn._is_stopped is False

        conn._active_task.cancel()
        try:
            await conn._active_task
        except (asyncio.CancelledError, Exception):
            pass

    @pytest.mark.asyncio
    async def test_approval_passes_guidance_queue(self):
        conn = make_connection()
        orchestrator = MagicMock()
        orchestrator.resume_after_approval_with_streaming = AsyncMock(return_value=MagicMock())
        handler = make_handler(orchestrator)

        await handler.handle_approval(conn, {"decision": "approve"})
        # Wait for background task to complete
        await asyncio.sleep(0.05)

        call_args = orchestrator.resume_after_approval_with_streaming.call_args
        assert call_args.kwargs.get("guidance_queue") is conn.guidance_queue

    @pytest.mark.asyncio
    async def test_answer_passes_guidance_queue(self):
        conn = make_connection()
        orchestrator = MagicMock()
        orchestrator.resume_after_answer_with_streaming = AsyncMock(return_value=MagicMock())
        handler = make_handler(orchestrator)

        await handler.handle_answer(conn, {"answer": "192.168.1.1"})
        # Wait for background task to complete
        await asyncio.sleep(0.05)

        call_args = orchestrator.resume_after_answer_with_streaming.call_args
        assert call_args.kwargs.get("guidance_queue") is conn.guidance_queue


# =============================================================================
# MAIN
# =============================================================================

if __name__ == "__main__":
    pytest.main([__file__, "-v"])
