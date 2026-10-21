import { useAuth } from "@/features/auth/AuthProvider";
import { getToken, refresh } from "@/shared/api/client";
import { Message, UiEvent, mergeMessages } from "@/shared/contracts";
import { useQueryClient } from "@tanstack/react-query";
import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
const StreamContext = createContext<{
  online: boolean;
  messages: Record<string, Message[]>;
  events: UiEvent[];
}>({ online: false, messages: {}, events: [] });
export function StreamProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [online, setOnline] = useState(false),
    [messages, setMessages] = useState<Record<string, Message[]>>({}),
    [events, setEvents] = useState<UiEvent[]>([]);
  const seq = useRef("0");
  const query = useQueryClient();
  useEffect(() => {
    if (!user) return;
    let stopped = false,
      socket: WebSocket | undefined,
      timer: ReturnType<typeof setTimeout> | undefined;
    seq.current = "0";
    setMessages({});
    setEvents([]);
    const connect = () => {
      if (stopped) return;
      socket = new WebSocket(
        `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`,
      );
      socket.onopen = () =>
        socket?.send(
          JSON.stringify({
            type: "auth",
            accessToken: getToken(),
            sinceSeq: seq.current,
          }),
        );
      socket.onmessage = (event) => {
        try {
          const frame = JSON.parse(event.data);
          if (frame.type === "auth") {
            setOnline(frame.success === true);
            return;
          }
          if (
            !/^\d+$/.test(frame.seq) ||
            BigInt(frame.seq) <= BigInt(seq.current)
          )
            return;
          const e = frame as UiEvent;
          if (["message", "message_updated"].includes(e.type)) {
            const m = e.payload.message as unknown as Message;
            if (!m?.id) throw Error("消息投影缺失");
            setMessages((old) => ({
              ...old,
              [m.groupId]: mergeMessages(old[m.groupId] || [], [m]),
            }));
          }
          setEvents((old) => [e, ...old].slice(0, 40));
          seq.current = e.seq;
          void query.invalidateQueries({
            predicate: (q) => !["messages"].includes(String(q.queryKey[0])),
          });
        } catch {
          socket?.close();
        }
      };
      socket.onclose = async (event) => {
        setOnline(false);
        if (stopped) return;
        if (event.code === 4001) {
          try {
            await refresh();
          } catch {
            window.dispatchEvent(new Event("session-ended"));
            return;
          }
        }
        timer = setTimeout(connect, 500);
      };
    };
    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      socket?.close();
      setOnline(false);
    };
  }, [user, query]);
  return (
    <StreamContext.Provider value={{ online, messages, events }}>
      {children}
    </StreamContext.Provider>
  );
}
export const useStream = () => useContext(StreamContext);
