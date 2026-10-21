import { IsString, Length } from "class-validator";
export class SendDto {
  @IsString() @Length(1, 200) accountId!: string;
  @IsString() @Length(1, 10000) text!: string;
}
