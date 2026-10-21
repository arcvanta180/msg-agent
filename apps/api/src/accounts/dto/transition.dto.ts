import { IsIn } from "class-validator";
import {
  AccountStatus,
  transitions,
} from "../../../../../packages/contracts/src";
export class TransitionDto {
  @IsIn(Object.keys(transitions)) to!: AccountStatus;
  @IsIn(Object.keys(transitions)) expectedFrom!: AccountStatus;
}
