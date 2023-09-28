'use strict';
const Consumer = require('../');
const expect = require('chai').expect;
const sinon = require('sinon');
const sandbox = sinon.createSandbox();
const {
	SQSClient,
	DeleteMessageCommand,
	ReceiveMessageCommand,
	ChangeMessageVisibilityCommand
} = require('@aws-sdk/client-sqs');
const {mockClient} = require('aws-sdk-client-mock');

describe('SQS Consumer', () => {
	let consumer;
	let handleMessage;
	let onError;
	let sqsMock;
	const queueUrl = 'https://sqs.eu-central/queue';

	const response = {
		Messages: [{
			ReceiptHandle: 'handle',
			MessageId: '1',
			Body: 'b'
		}]
	};

	beforeEach(() => {
		sqsMock = mockClient(SQSClient);
		onError = sandbox.stub();
		sqsMock.on(ReceiveMessageCommand).resolves(response);
		sqsMock.on(DeleteMessageCommand).resolves();
		handleMessage = sandbox.stub().callsArgWith(1, null);

		consumer = new Consumer({
			queueUrl,
			handleMessage
		});

		// prevent it to poll like crazy since we stub receiveMessage()
		consumer.shouldWePoll = () => false;
		consumer.on('error', onError);
	});

	afterEach(async () => {
		sandbox.restore();
		consumer.numActiveMessages = 0;
		sqsMock.restore();
		await consumer.stop();
	});

	describe('start()', () => {
		it('polls on start', async () => {
			await consumer.start();
			expect(handleMessage.callCount).to.equal(1);
			expect(handleMessage.getCall(0).args[0]).to.deep.equal(response.Messages[0]);

			// handleMessage callback should delete the message from the queue
			expect(sqsMock.commandCalls(DeleteMessageCommand)).to.have.lengthOf(1);
			expect(sqsMock.commandCalls(DeleteMessageCommand)[0].args[0].input).to.deep.equal({
				QueueUrl: queueUrl,
				ReceiptHandle: response.Messages[0].ReceiptHandle
			});

			expect(onError.callCount).to.equal(0);
		});
	});

	describe('stop()', () => {
		it('should return right away if gracefulTimeout is falsy', async () => {
			await consumer.start();
			consumer.numActiveMessages = 1;
			const shutdownPromise = consumer.stop();
			await Promise.race([shutdownPromise, new Promise((resolve, reject) => reject('still running'))]);
		});

		it('should return right away if we have no active messages', async () => {
			await consumer.start();
			consumer.numActiveMessages = 0;
			const shutdownPromise = consumer.stop(20 * 1000);
			await Promise.race([shutdownPromise, new Promise((resolve, reject) => reject('still running'))]);
		});

		it('should wait until active messages have been drained before returning', async () => {
			await consumer.start();
			consumer.numActiveMessages = 1;
			const shutdownPromise = consumer.stop(20 * 1000);

			let res = await Promise.race([shutdownPromise, new Promise((resolve) => resolve('still running'))]);
			expect(res).to.equal('still running');

			consumer.numActiveMessages = 0;
			while (true) {
				res = await Promise.race([
					shutdownPromise,
					new Promise((resolve) => setTimeout(() => {
						resolve('still running');
					}, 10))
				]);
				if (res !== 'still running') {
					break;
				}
			}
		});
	});

	describe('getMaxNumberOfMessages()', () => {
		it('should return max 10', () => {
			consumer.batchSize = 15;
			consumer.numActiveMessages = 0;
			expect(consumer.getMaxNumberOfMessages()).to.equal(10);
		});

		it('should return batchSize - numActiveMessages', () => {
			consumer.batchSize = 15;
			consumer.numActiveMessages = 10;
			expect(consumer.getMaxNumberOfMessages()).to.equal(5);
		});

		it('should never be less than 1', () => {
			consumer.batchSize = 15;
			consumer.numActiveMessages = 15;
			expect(consumer.getMaxNumberOfMessages()).to.equal(1);

			consumer.batchSize = 15;
			consumer.numActiveMessages = 20;
			expect(consumer.getMaxNumberOfMessages()).to.equal(1);
		});
	});

	describe('handleMessage', () => {
		it('callback with error returns message to queue', async () => {
			consumer.handleMessage = sandbox.stub().callsArgWith(1, new Error('shit'));
			await consumer.poll();

			expect(sqsMock.commandCalls(DeleteMessageCommand)).to.have.lengthOf(0);

			expect(sqsMock.commandCalls(ChangeMessageVisibilityCommand)).to.have.lengthOf(1);
			expect(sqsMock.commandCalls(ChangeMessageVisibilityCommand)[0].args[0].input).to.deep.equal({
				QueueUrl: queueUrl,
				ReceiptHandle: response.Messages[0].ReceiptHandle,
				VisibilityTimeout: 0
			});
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
