import { Module } from "@nestjs/common";
import { SearchModule } from "../search/search.module";
import { PeopleController } from "./people.controller";
import { PeopleService } from "./people.service";

@Module({
  imports: [SearchModule],
  controllers: [PeopleController],
  providers: [PeopleService],
  exports: [PeopleService],
})
export class PeopleModule {}
