import assert from 'node:assert/strict';
import test from 'node:test';
import { routeMessage } from '../chat';

test('pause/resume phrases route to control intents', () => {
	assert.equal(routeMessage('Pause proactive assistance.', false).type, 'pause');
	assert.equal(routeMessage('stop teaching me proactively', false).type, 'pause');
	assert.equal(routeMessage('please disable proactive messages', false).type, 'pause');
	assert.equal(routeMessage('resume proactive assistance', true).type, 'resume');
	assert.equal(routeMessage('enable proactive insights', false).type, 'resume');
});

test('"why are you telling me this" asks for an explanation of proactive behavior', () => {
	assert.equal(routeMessage('Why are you telling me this?', false).type, 'why');
	assert.equal(routeMessage('why do you keep messaging me', false).type, 'why');
});

test('a pending question turns plain text into a quiz answer', () => {
	assert.equal(routeMessage('it returns a promise', true).type, 'quiz-answer');
	assert.equal(routeMessage('it returns a promise', false).type, 'direct');
});

test('ordinary questions and commands go direct', () => {
	for (const text of [
		'Explain what I am looking at',
		'Give me the short version',
		'Stop teaching and just answer my question',
		'Why did this error happen?',
	]) {
		assert.equal(routeMessage(text, false).type, 'direct', text);
	}
});

test('control intents win over the quiz answer', () => {
	assert.equal(routeMessage('pause proactive', true).type, 'pause');
});
