'use strict';

const AWS = require('aws-sdk');
const EventEmitter = require('events');

const clientDefaults = {
	apiVersion: '2012-11-05'
};

class SQSConsumer extends EventEmitter {

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
		this.client = new AWS.SQS(Object.assign({}, clientDefaults, aws));
		this.numActiveMessages = 0; // how many message are we currently processing
		this.activeRequest = false;
		this.active = false;
		this.intervalId = null;
	}

	deleteMessage(receiptHandle) {
		const params = {
			QueueUrl: this.queueUrl,
			ReceiptHandle: receiptHandle
		};

		return this.client.deleteMessage(params).promise();
	}

	async poll() {
		const params = {
			QueueUrl: this.queueUrl,
			AttributeNames: ['All'],
			MessageAttributeNames: this.messageAttributeNames,
			MaxNumberOfMessages: this.getMaxNumberOfMessages(),
			WaitTimeSeconds: this.waitTimeSeconds
		};

		let timeout;
		try {
			this.activeRequest = this.client.receiveMessage(params);
			timeout = setTimeout(this.abort.bind(this), (this.waitTimeSeconds + 5) * 1000);
			const res = await this.activeRequest.promise();
			clearTimeout(timeout);
			this.activeRequest = false;
			const numMessages = res.Messages ? res.Messages.length : 0;

			this.emit('didPoll');

			if (numMessages) {
				res.Messages.forEach((msg) => {
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
			clearTimeout(timeout);
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

	returnMessageToQueue(receiptHandle) {
		const params = {
			QueueUrl: this.queueUrl,
			ReceiptHandle: receiptHandle,
			VisibilityTimeout: 0
		};
		return this.client.changeMessageVisibility(params).promise();
	}

	createCallback(msg) {
		return async (err) => {
			this.numActiveMessages--;
			this.shouldWePoll();
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
			this.activeRequest.abort();
			this.activeRequest = false;
		}
	}

	async stop(timeout = 20 * 1000) {
		this.active = false;
		this.abort();
		clearInterval(this.intervalId);
		const start = Date.now();
		while (Date.now() > start - timeout) {
			if (this.numActiveMessages <= 0) {
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
	}
}

module.exports = SQSConsumer;
