import { fail } from "../common/errors";
import { VarsDto } from "./dto/sequence.dto";
export function validateVars(dto: VarsDto) {
  for (const [key, value] of Object.entries(dto.vars)) {
    if (
      !/^[A-Za-z0-9_]+$/.test(key) ||
      typeof value !== "string" ||
      value.length > 10000
    )
      fail(400, "VALIDATION_ERROR", "vars 必须是字符串键值对");
  }
  for (const [index, values] of Object.entries(dto.stepVars)) {
    if (
      !/^\d+$/.test(index) ||
      !values ||
      typeof values !== "object" ||
      Array.isArray(values) ||
      Object.values(values).some(
        (v) => typeof v !== "string" || v.length > 10000,
      ) ||
      Object.keys(values).some((k) => !/^[A-Za-z0-9_]+$/.test(k))
    )
      fail(400, "VALIDATION_ERROR", "stepVars 格式错误");
  }
}
