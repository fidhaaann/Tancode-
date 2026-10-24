import assert from 'node:assert/strict';
import test from 'node:test';
import { dispatchWebviewMessage, WEBVIEW_MESSAGE_TYPES, WebviewActions } from '../messages';

function recorder() {
	const calls: string[] = [];
	const actions: WebviewActions = {
		detail: () => calls.push('detail'),
		summary: () => calls.push('summary'),
		retry: () => calls.push('retry'),
		explain: () => calls.push('explain'),
		learn: () => calls.push('learn'),
		practice: () => calls.push('practice'),
		newQuestion: () => calls.push('newQuestion'),
		submitAnswer: text => calls.push(`submitAnswer:${text}`),
		backToFile: () => calls.push('backToFile'),
	};
	return { calls, actions };
}

test('every declared message type dispatches to exactly one handler', () => {
	const expected: Record<string, string> = {
		detail: 'detail',
		summary: 'summary',
		retry: 'retry',
		explain: 'explain',
		learn: 'learn',
		practice: 'practice',
		'new-question': 'newQuestion',
		file: 'backToFile',
	};
	for (const type of WEBVIEW_MESSAGE_TYPES.filter(t => t !== 'submit-answer')) {
		const { calls, actions } = recorder();
		assert.equal(dispatchWebviewMessage({ type }, actions), true, `type ${type} should dispatch`);
		assert.deepEqual(calls, [expected[type]], `type ${type} hit the wrong handler`);
	}
});

test('submit-answer carries its text payload to the handler', () => {
	const { calls, actions } = recorder();
	assert.equal(dispatchWebviewMessage({ type: 'submit-answer', text: 'it returns 42' }, actions), true);
	assert.deepEqual(calls, ['submitAnswer:it returns 42']);
});

test('malformed and unknown messages are ignored without throwing', () => {
	const { calls, actions } = recorder();
	for (const bad of [
		undefined, null, 42, 'retry', {},
		{ type: 'submit-answer' },               // missing payload
		{ type: 'submit-answer', text: 5 },      // wrong payload type
		{ type: 'definitely-not-a-command' },
	]) {
		assert.equal(dispatchWebviewMessage(bad, actions), false);
	}
	assert.deepEqual(calls, [], 'no handler may run for malformed input');
});
