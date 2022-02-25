# SQS Consumer

Module for consuming AWS SQS queue.

Inspired by https://github.com/bbc/sqs-consumer but allows `batchSize` to be higher than 10

# Example

```javascript

const Consumer = require('@aptoma/sqs-consumer');
const app = new Consumer({
	queueUrl: 'https://sqs.eu-central-1.amazonaws.com/....',
	batchSize: 15,
	waitTimeSeconds: 10,
	aws: {
		region: 'eu-central-1'
	},
	async handleMessage(message, cb) {
		console.log(message);
		await doSometing(message);
		cb();
	}
});

app.on('error', console.error);

(async () => {
	await app.start();
})();

```
