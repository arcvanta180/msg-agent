import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsInt,
  IsObject,
  IsString,
  Length,
  Max,
  Min,
  ValidateNested,
} from "class-validator";
export class SequenceStepDto {
  @IsInt() @Min(1) @Max(100) index!: number;
  @IsIn(["admin", "member"]) accountRole!: "admin" | "member";
  @IsString() @Length(1, 10000) text!: string;
  @IsInt() @Min(0) @Max(86400) delaySeconds!: number;
}
export class SequenceDto {
  @IsString() @Length(1, 200) name!: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => SequenceStepDto)
  steps!: SequenceStepDto[];
}
export class VarsDto {
  @IsObject() vars!: Record<string, string>;
  @IsObject() stepVars!: Record<string, Record<string, string>>;
}
export class StartDto extends VarsDto {
  @IsString() @Length(1, 200) sequenceId!: string;
}
