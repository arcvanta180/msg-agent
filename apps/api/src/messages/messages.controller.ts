import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
} from "@nestjs/common";
import { fail } from "../common/errors";
import { SendDto } from "./dto/send.dto";
import { MessagesService } from "./messages.service";
@Controller("api")
export class MessagesController {
  constructor(@Inject(MessagesService) private messages: MessagesService) {}
  @Post("groups/:id/send") @HttpCode(202) async send(
    @Param("id") key: string,
    @Body() body: SendDto,
  ) {
    const m = await this.messages.send(key, body.accountId, body.text);
    return { clientMsgId: m.clientMsgId, message: m };
  }
  @Get("groups/:id/messages") page(
    @Param("id") key: string,
    @Query("before") before?: string,
    @Query("limit") limit?: string,
  ) {
    if (
      limit &&
      (!/^\d+$/.test(limit) || Number(limit) < 1 || Number(limit) > 100)
    )
      fail(400, "VALIDATION_ERROR", "limit 范围 1–100");
    return this.messages.page(key, before, Number(limit || 50));
  }
}
