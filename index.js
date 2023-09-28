// @ts-check
'use strict';

const {
	SQSClient,
	DeleteMessageCommand,
	ReceiveMessageCommand,
	ChangeMessageVisibilityCommand
} = require('@aws-sdk/client-sqs');
const EventEmitter = require('events');

class SQSConsumer extends EventEmitter {

	/**
	 * @param {SQSConsumerConfig} config
	 */
	constructor({
		queueUrl,
		aws = {},
		messageAttributeNames = [],
		batchSize = 1,
		waitTimeSeconds = 0,
		handleMessage
	}) {
		super();
		this.queueUrl = queueUrl;
		this.messageAttributeNames = messageAttributeNames;
		this.waitTimeSeconds = waitTimeSeconds;
		this.handleMessage = handleMessage;
		this.batchSize = batchSize;
		this.client = new SQSClient(aws);
		this.numActiveMessages = 0; // how many message are we currently processing
		/** @type {Promise<ReceiveMessageCommandOutput> | boolean} */
		this.activeRequest = false;
		this.active = false;
		/** @type {NodeJS.Timeout | undefined} */
		this.intervalId = undefined;
	}

	/**
	 * @param {string} receiptHandle
	 * @return {Promise<DeleteMessageCommandOutput>}
	 */
	deleteMessage(receiptHandle) {
		const cmd = new DeleteMessageCommand({
			QueueUrl: this.queueUrl,
			ReceiptHandle: receiptHandle
		});

		return this.client.send(cmd);
	}

	async poll() {
		const params = {
			QueueUrl: this.queueUrl,
			AttributeNames: ['All'],
			MessageAttributeNames: this.messageAttributeNames,
			MaxNumberOfMessages: this.getMaxNumberOfMessages(),
			WaitTimeSeconds: this.waitTimeSeconds,
			abortSignal: new AbortController().signal

		};

		/** @type {NodeJS.Timeout | undefined} */
		let timeout;
		try {
			this.activeAbortController = new AbortController();
			this.activeRequest = this.client.send(new ReceiveMessageCommand(params), {abortSignal: this.activeAbortController.signal});
			timeout = setTimeout(this.abort.bind(this), (this.waitTimeSeconds + 5) * 1000);
			const res = await this.activeRequest;
			clearTimeout(timeout);
			this.activeRequest = false;
			const numMessages = res.Messages ? res.Messages.length : 0;

			this.emit('didPoll');
			if (numMessages) {
				res.Messages?.forEach((msg) => {
					this.numActiveMessages++;
					this.handleMessage(msg, this.createCallback(msg)).catch((err) => {
						this.emit('error', err);
					});
				});
			}

			this.shouldWePoll();
		} catch (err) {
			this.activeRequest = false;
			throw err;
		} finally {
			if (timeout) {
				clearTimeout(timeout);
			}
		}
	}

	getMaxNumberOfMessages() {
		let max = this.batchSize - this.numActiveMessages;
		if (max > 10) {
			max = 10;
		} else if (max < 1) {
			max = 1;
		}

		return max;
	}

	async shouldWePoll() {
		if (this.active && !this.activeRequest && this.numActiveMessages < this.batchSize) {
			try {
				await this.poll();
			} catch (err) {
				this.emit('error', err);
			}
		}
	}

	/**
	 * @param {string} receiptHandle
	 * @return {Promise<ChangeMessageVisibilityCommandOutput>}
	 */
	returnMessageToQueue(receiptHandle) {
		const cmd = new ChangeMessageVisibilityCommand({
			QueueUrl: this.queueUrl,
			ReceiptHandle: receiptHandle,
			VisibilityTimeout: 0
		});
		return this.client.send(cmd);
	}

	/**
	 * @param {Message} msg
	 * @return {MessageCallback}
	 */
	createCallback(msg) {
		return async (err) => {
			this.numActiveMessages--;
			this.shouldWePoll();
			if (msg.ReceiptHandle) {
				if (err) {
					try {
						await this.returnMessageToQueue(msg.ReceiptHandle);
					} catch (err) {
						this.emit('error', err);
					}

					return;
				}

				try {
					await this.deleteMessage(msg.ReceiptHandle);
				} catch (err) {
					this.emit('error', err);
				}
			}
		};
	}

	async start() {
		this.active = true;
		// do first poll and wait for it to be able to throw on start
		await this.poll();

		this.intervalId = setInterval(() => this.shouldWePoll(), 1000); // keep things alive;
	}

	abort() {
		if (this.activeRequest) {
			this.activeAbortController?.abort();
			this.activeRequest = false;
			this.activeAbortController = undefined;
		}
	}

	async stop(gracefulTimeout = 0) {
		this.active = false;
		this.abort();
		if (this.intervalId) {
			clearInterval(this.intervalId);
		}
		if (!gracefulTimeout || isNaN(Number(gracefulTimeout))) {
			return;
		}
		const start = Date.now();
		while (Date.now() > start - Number(gracefulTimeout)) {
			if (this.numActiveMessages <= 0) {
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
}

module.exports = SQSConsumer;

/**
 * @typedef {object} SQSConsumerConfig
 * @property {string} queueUrl
 * @property {import('@aws-sdk/client-sqs').SQSClientConfig} [aws]
 * @property {string[]} [messageAttributeNames]
 * @property {number} [batchSize]
 * @property {number} [waitTimeSeconds]
 * @property {SQSConsumerMessageHandler} handleMessage
 *
 * @typedef {(msg: Message, cb: MessageCallback) => Promise<any>} SQSConsumerMessageHandler
 * @typedef {(error?: Error) => Promise<void>} MessageCallback
 *
 * @typedef {import('@aws-sdk/client-sqs').Message} Message
 * @typedef {import('@aws-sdk/client-sqs').ReceiveMessageCommandOutput} ReceiveMessageCommandOutput
 * @typedef {import('@aws-sdk/client-sqs').DeleteMessageCommandOutput} DeleteMessageCommandOutput
 * @typedef {import('@aws-sdk/client-sqs').ChangeMessageVisibilityCommandOutput} ChangeMessageVisibilityCommandOutput
 */
