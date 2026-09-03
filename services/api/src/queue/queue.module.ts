import { Global, Module } from "@nestjs/common";
import { QueueProducerService } from "./queue-producer.service";
import { QUEUE_PRODUCER } from "./queue-producer.interface";

@Global()
@Module({
  providers: [QueueProducerService, { provide: QUEUE_PRODUCER, useExisting: QueueProducerService }],
  exports: [QueueProducerService, QUEUE_PRODUCER],
})
export class QueueModule {}
