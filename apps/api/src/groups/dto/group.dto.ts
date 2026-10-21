import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsOptional,
  IsString,
  Length,
} from "class-validator";
export class GroupDto {
  @IsString() @Length(1, 200) creatorAccountId!: string;
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsString({ each: true })
  memberAccountIds!: string[];
}
export class PatchGroupDto {
  @IsOptional() @IsBoolean() agentEnabled?: boolean;
  @IsOptional() @IsBoolean() autoKickEnabled?: boolean;
}
