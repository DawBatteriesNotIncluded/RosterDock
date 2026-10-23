import type { CompanyData } from "../api/types.ts";
import { Avatar, Empty, Topbar } from "../components/ui.tsx";
import { cn } from "../lib/cn.ts";
import { describeEvent, relativeTime } from "../lib/format.ts";

export function ActivityView({
  data,
  meId,
  onOpen,
}: {
  data: CompanyData;
  meId?: string;
  onOpen(go: { taskId?: string; reviewId?: string } | undefined): void;
}) {
  return (
    <>
      <Topbar title="Activity" subtitle={`${data.company.name} · everything the team did, newest first`} />
      <div className="content">
        <div className="activity scroll">
          <div className="feed">
            {data.events.map((ev) => {
              const s = describeEvent(ev, data, meId);
              const actor = ev.actor;
              const teammate =
                actor?.kind === "teammate" ? data.teammates.find((t) => t.id === actor.id) : undefined;
              const name =
                teammate?.name ?? data.members.find((m) => m.userId === actor?.id)?.name ?? "RosterDock";
              return (
                <button
                  key={ev.id}
                  className={cn("feed-item", s.attention && "attention")}
                  onClick={() => onOpen(s.go)}
                >
                  <Avatar
                    name={name}
                    handle={teammate?.handle}
                    you={actor?.kind === "user" && actor.id === meId}
                  />
                  <div>
                    <div className="txt">{s.text}</div>
                    <div className="meta">{relativeTime(ev.createdAt)}</div>
                  </div>
                </button>
              );
            })}
            {data.events.length === 0 ? <Empty>No activity in this company yet.</Empty> : null}
          </div>
        </div>
      </div>
    </>
  );
}
