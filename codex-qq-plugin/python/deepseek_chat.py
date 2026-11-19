"""DeepSeek thinking responses can continue through a LangChain tool turn."""
from langchain_core.messages import AIMessage
from langchain_deepseek import ChatDeepSeek


class ThinkingDeepSeek(ChatDeepSeek):
    def _get_request_payload(self, input_, *, stop=None, **kwargs):
        payload = super()._get_request_payload(input_, stop=stop, **kwargs)
        if payload.get('tools'):
            # The SDK reads reasoning_content but does not send it back. DeepSeek
            # requires it for prior tool calls in the same invocation.
            messages = self._convert_input(input_).to_messages()
            for message, wire in zip(messages, payload['messages'], strict=True):
                if isinstance(message, AIMessage) and wire['role'] == 'assistant':
                    reasoning = message.additional_kwargs.get('reasoning_content')
                    if isinstance(reasoning, str):
                        wire['reasoning_content'] = reasoning
        return payload
