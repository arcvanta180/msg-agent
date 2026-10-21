import { Inject, Injectable } from "@nestjs/common";
import { Account, Group, Message } from "../../../../packages/contracts/src";
import { Database, id } from "../../../../packages/db/src";
import { fail, required } from "../common/errors";
import { outbound } from "./outbound";
@Injectable()
export class MessagesService {
  constructor(@Inject(Database) private db: Database) {}
  async send(groupId: string, accountId: string, text: string) {
    return this.db.tx(async (s) =>
      outbound(
        s,
        required(await s.get<Group>("groups", groupId), "GROUP_NOT_FOUND"),
        required(
          await s.get<Account>("accounts", accountId),
          "ACCOUNT_NOT_FOUND",
        ),
        text,
      ),
    );
  }
  async page(groupId: string, before: string | undefined, limit: number) {
    return this.db.tx(async (s) => {
      required(await s.get<Group>("groups", groupId), "GROUP_NOT_FOUND");
      let snapshot:
        | {
            id: string;
            groupId: string;
            items: Message[];
            expiresAt: string;
            snapshotSeq: string;
          }
        | undefined;
      let offset = 0;
      if (before) {
        const match = /^([a-f0-9-]{36})\.(\d+)$/.exec(before);
        if (!match) fail(400, "INVALID_CURSOR");
        snapshot = await s.get("timeline_snapshots", match![1]);
        offset = Number(match![2]);
        if (
          !snapshot ||
          snapshot.groupId !== groupId ||
          Date.parse(snapshot.expiresAt) < Date.now()
        )
          fail(410, "SNAPSHOT_EXPIRED");
      } else {
        snapshot = {
          id: id(),
          groupId,
          items: (await s.all<Message>("messages"))
            .filter((m) => m.groupId === groupId)
            .sort(
              (a, b) =>
                b.sentAt.localeCompare(a.sentAt) || b.id.localeCompare(a.id),
            ),
          expiresAt: new Date(Date.now() + 15 * 60000).toISOString(),
          snapshotSeq: await s.seq(),
        };
        await s.put("timeline_snapshots", snapshot);
      }
      const items = snapshot!.items.slice(offset, offset + limit);
      return {
        items,
        nextCursor:
          offset + limit < snapshot!.items.length
            ? `${snapshot!.id}.${offset + limit}`
            : null,
        snapshotSeq: snapshot!.snapshotSeq,
      };
    });
  }
}
