import { Global, Module } from "@nestjs/common";
import { QueueProducerService } from "./queue-producer.service";

@Global()
@Module({
  providers: [QueueProducerService],
  exports: [QueueProducerService],
})
export class QueueModule {}
