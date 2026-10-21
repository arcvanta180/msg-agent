import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
} from "@nestjs/common";
import { AccountsService } from "./accounts.service";
import { TransitionDto } from "./dto/transition.dto";
@Controller("api")
export class AccountsController {
  constructor(@Inject(AccountsService) private accounts: AccountsService) {}
  @Get("accounts") listAccounts() {
    return this.accounts.list();
  }
  @Post("accounts/:id/connect") @HttpCode(200) connect(
    @Param("id") key: string,
  ) {
    return this.accounts.connect(key);
  }
  @Post("accounts/:id/transition") @HttpCode(200) transition(
    @Param("id") key: string,
    @Body() body: TransitionDto,
  ) {
    return this.accounts.change(key, body.to, body.expectedFrom);
  }
}
