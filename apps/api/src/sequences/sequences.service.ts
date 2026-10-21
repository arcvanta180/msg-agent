import { Inject, Injectable } from "@nestjs/common";
import {
  Group,
  SequenceDefinition,
  SequenceRun,
  resolveSteps,
} from "../../../../packages/contracts/src";
import { Database, id, now } from "../../../../packages/db/src";
import { fail, required } from "../common/errors";
@Injectable()
export class SequencesService {
  constructor(@Inject(Database) private db: Database) {}
  list() {
    return this.db.read().all<SequenceDefinition>("sequences");
  }
  async create(def: Omit<SequenceDefinition, "id">) {
    const sequence = { ...def, id: id() };
    await this.db.tx((s) => s.put("sequences", sequence));
    return { id: sequence.id };
  }
  async preview(
    sequenceId: string,
    vars: Record<string, string>,
    stepVars: Record<string, Record<string, string>>,
  ) {
    const def = required(
      await this.db.read().get<SequenceDefinition>("sequences", sequenceId),
      "SEQUENCE_NOT_FOUND",
    );
    try {
      return { steps: resolveSteps(def, vars, stepVars) };
    } catch (e) {
      const error = e as Error & { stepIndex: number; key: string };
      fail(422, "UNRESOLVED_PLACEHOLDER", error.message, {
        stepIndex: error.stepIndex,
        key: error.key,
      });
    }
  }
  async start(
    groupId: string,
    sequenceId: string,
    vars: Record<string, string>,
    stepVars: Record<string, Record<string, string>>,
  ) {
    return this.db.tx(async (s) => {
      const g = required(
        await s.get<Group>("groups", groupId),
        "GROUP_NOT_FOUND",
      );
      if (g.status !== "active" || g.closing) fail(409, "GROUP_UNREACHABLE");
      const def = required(
        await s.get<SequenceDefinition>("sequences", sequenceId),
        "SEQUENCE_NOT_FOUND",
      );
      let steps;
      try {
        steps = resolveSteps(def, vars, stepVars);
      } catch (e) {
        const error = e as Error & { stepIndex: number; key: string };
        fail(422, "UNRESOLVED_PLACEHOLDER", error.message, {
          stepIndex: error.stepIndex,
          key: error.key,
        });
      }
      if (
        (await s.all<SequenceRun>("sequence_runs")).some(
          (r) => r.groupId === groupId && r.status === "running",
        )
      )
        fail(409, "SEQUENCE_ALREADY_RUNNING");
      const run: SequenceRun = {
        id: id(),
        groupId,
        sequenceId,
        status: "running",
        currentStepIndex: 1,
        steps: steps!,
        createdAt: now(),
      };
      run.steps[0].scheduledAt = new Date(
        Date.now() + run.steps[0].delaySeconds * 1000,
      ).toISOString();
      await s.put("sequence_runs", run);
      await s.event("sequence_run", { runId: run.id, ...run });
      return { runId: run.id };
    });
  }
}
