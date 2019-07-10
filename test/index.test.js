'use strict';
const Consumer = require('../');
const expect = require('chai').expect;
const sinon = require('sinon');
const sandbox = sinon.createSandbox();

function stubPromiseResolve(value) {
	return sandbox.stub().returns({promise: sandbox.stub().resolves(value)});
}

describe('SQS Consumer', () => {
	let consumer;
	let handleMessage;
	let sqs;
	let onError;
	const queueUrl = 'https://sqs.eu-central/queue';

	const response = {
		Messages: [{
			ReceiptHandle: 'handle',
			MessageId: '1',
			Body: 'b'
		}]
	};

	beforeEach(() => {
		onError = sandbox.stub();
		sqs = sandbox.mock();
		sqs.deleteMessage = stubPromiseResolve();
		sqs.receiveMessage = stubPromiseResolve(response);
		sqs.changeMessageVisibility = stubPromiseResolve();

		handleMessage = sandbox.stub().callsArgWith(1, null);

		consumer = new Consumer({
			queueUrl,
			handleMessage
		});

		// prevent it to poll like crazy since we stub receiveMessage()
		consumer.shouldWePoll = () => false;
		consumer.client = sqs;
		consumer.on('error', onError);
	});

	afterEach(() => {
		sandbox.restore();
		consumer.stop();
	});

	describe('start()', () => {
		it('polls on start', async () => {
			await consumer.start();
			expect(handleMessage.callCount).to.equal(1);
			expect(handleMessage.getCall(0).args[0]).to.deep.equal(response.Messages[0]);

			// handleMessage callback should delete the message from the queue
			expect(sqs.deleteMessage.calledWith({
				QueueUrl: queueUrl,
				ReceiptHandle: response.Messages[0].ReceiptHandle
			})).to.be.true;

			expect(onError.callCount).to.equal(0);
		});
	});

	describe('handleMessage', () => {
		it('callback with error returns message to queue', async () => {
			consumer.handleMessage = sandbox.stub().callsArgWith(1, new Error('shit'));
			await consumer.poll();

			expect(sqs.deleteMessage.callCount).to.equal(0);

			// return to queue
			expect(sqs.changeMessageVisibility.calledWith({
				QueueUrl: queueUrl,
				ReceiptHandle: response.Messages[0].ReceiptHandle,
				VisibilityTimeout: 0
			})).to.be.true;
		});

		it('catch and emit promise errors', async () => {
			consumer.handleMessage = async () => {
				throw new Error('shit');
			};

			await consumer.poll();

			expect(onError.callCount).to.equal(1);
		});
	});
});
