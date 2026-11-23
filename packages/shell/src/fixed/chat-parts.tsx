// What the chat's views share: a conversation's row, your conversations as a list of them, the
// pinned ones as tiles above the rest, dragged with dnd-kit, and the control that collapses the chat.
import {
  type CollisionDetection,
  closestCenter,
  DndContext,
  DragOverlay,
  KeyboardSensor,
  type Modifier,
  MouseSensor,
  pointerWithin,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import {
  arrayMove,
  rectSortingStrategy,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
} from "@dnd-kit/sortable";
import { CircleAlertIcon, PinIcon, PinOffIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "../ui/button.tsx";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "../ui/context-menu.tsx";
import { type ListedChat, useAllChats } from "./all-chats.tsx";
import { useChats } from "./chats.tsx";
import { useEvery } from "./data.ts";
import { Face } from "./face.tsx";

/** How long ago, in the one short form a row has room for. */
export function age(at: string, now = Date.now()): string {
  const minutes = Math.floor((now - Date.parse(at)) / 60_000);
  if (Number.isNaN(minutes)) return "";
  if (minutes < 1) return "Now";
  if (minutes < 60) return `${minutes} min`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h`;
  const days = Math.floor(minutes / (24 * 60));
  return days < 7 ? `${days} d` : `${Math.floor(days / 7)} wk`;
}

const TIME = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });
const DATE = new Intl.DateTimeFormat(undefined, { dateStyle: "short" });
/** When something was said, as the person's locale writes it short: today, its time; before today, its date. */
export function timeOf(at: string, now = new Date()): string {
  const when = new Date(at);
  if (Number.isNaN(when.getTime())) return "";
  return (when.toDateString() === now.toDateString() ? TIME : DATE).format(when);
}

/** Every list of conversations' rows: 4 px apart, so two highlights never touch. */
export const CHAT_ROWS = "flex flex-col gap-1";

/**
 * One conversation in a list: the agent, and its latest message or its problem. One between two
 * agents is shown by the agent it is with, where the other's page lists it. The one open beside the
 * list is marked.
 */
export function ChatRow({
  chat,
  agent = chat.agent,
  current = false,
  onOpen,
}: {
  chat: ListedChat;
  agent?: ListedChat["agent"];
  current?: boolean;
  onOpen(): void;
}) {
  const fresh = chat.unread;
  return (
    <button
      type="button"
      aria-current={current ? "true" : undefined}
      onClick={onOpen}
      className={`flex h-16 w-full items-center gap-3 rounded-xl px-2.5 text-left ${current ? "bg-[var(--selected)]" : "hover:bg-[var(--hover)]"}`}
    >
      <Face agent={agent} size={40} plain />
      <span className="min-w-0 flex-1">
        <span className={`block truncate text-[15px] ${fresh ? "font-semibold" : "font-medium"}`}>
          {agent.name}
        </span>
        <span className="flex min-w-0 gap-1.5 text-[13px] text-muted-foreground">
          {/* A conversation has no working state: only an agent works. A row says its problem, or its last words. */}
          {chat.problem ? (
            <span className="truncate text-[var(--bad)]">{chat.problem}</span>
          ) : (
            <span className="truncate">{chat.words}</span>
          )}
        </span>
      </span>
      <span className="flex shrink-0 flex-col items-end gap-1.5 self-start pt-3">
        <time dateTime={chat.at} className="text-xs whitespace-nowrap text-muted-foreground">
          {timeOf(chat.at)}
        </time>
        <span
          {...(fresh ? { role: "img", "aria-label": "New" } : {})}
          className={`size-2 rounded-full ${fresh ? "bg-[var(--unread)]" : ""}`}
        />
      </span>
    </button>
  );
}

/**
 * A pinned conversation: the agent's face over its name. Of what a row says, it keeps what matters
 * at a glance: that it is the one open, and before its name a mark for its problem, or for
 * something new.
 */
function ChatTile({
  chat,
  current,
  onOpen,
  handle,
}: {
  chat: ListedChat;
  current: boolean;
  onOpen(): void;
  /** What makes its button the one the keyboard picks the tile up by. */
  handle: React.ComponentProps<"button">;
}) {
  return (
    <button
      {...handle}
      type="button"
      aria-current={current ? "true" : undefined}
      onClick={onOpen}
      className={`flex w-full flex-col items-center gap-1.5 rounded-xl px-1.5 py-2.5 ${current ? "bg-[var(--selected)]" : "hover:bg-[var(--hover)]"}`}
    >
      <Face agent={chat.agent} size={48} plain />
      <span className="flex max-w-full items-center gap-1 text-xs">
        {chat.problem ? (
          <CircleAlertIcon
            role="img"
            aria-label={chat.problem}
            className="size-3 shrink-0 text-[var(--bad)]"
          />
        ) : (
          chat.unread && (
            <span
              role="img"
              aria-label="New"
              className="size-2 shrink-0 rounded-full bg-[var(--unread)]"
            />
          )
        )}
        <span className={`truncate ${chat.unread ? "font-semibold" : "font-medium"}`}>
          {chat.agent.name}
        </span>
      </span>
    </button>
  );
}

/** A conversation's menu, on its tile or its row: Pin, or Unpin. */
function PinMenu({
  pinned,
  onPin,
  children,
}: {
  pinned: boolean;
  onPin(): void;
  children: React.ReactElement;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onPin}>
          {pinned ? <PinOffIcon /> : <PinIcon />}
          {pinned ? "Unpin" : "Pin"}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** The tiles' grid as a place to drop on: between the tiles, after them, and while there are none. */
const PINNED = "pinned";
/**
 * The place of the conversation being dragged, where it would land: its room kept, nothing drawn in
 * it. What is in it stays there unseen, so the keyboard stays on a tile it has picked up.
 */
const SLOT = "rounded-xl bg-[var(--hover)] *:opacity-0";

interface Listed {
  chat: ListedChat;
  current: boolean;
  onOpen(): void;
  onPin(): void;
}

/** A pinned conversation's tile, which is dragged among the tiles: the others make room as it goes. */
function PinnedTile({ chat, current, onOpen, onPin }: Listed) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: chat.agent.id });
  return (
    <PinMenu pinned onPin={onPin}>
      <li
        ref={setNodeRef}
        data-chat={chat.agent.id}
        className={isDragging ? SLOT : ""}
        style={{
          transform: transform ? `translate3d(${transform.x}px, ${transform.y}px, 0)` : undefined,
          transition,
        }}
        {...listeners}
      >
        <ChatTile
          chat={chat}
          current={current}
          onOpen={onOpen}
          handle={{ ...attributes, ref: setActivatorNodeRef }}
        />
      </li>
    </PinMenu>
  );
}

/** A conversation's row, which is dragged up onto the tiles. */
function ListedRow({ chat, current, onOpen, onPin }: Listed) {
  const { listeners, setNodeRef, isDragging } = useDraggable({ id: chat.agent.id });
  return (
    <PinMenu pinned={false} onPin={onPin}>
      <li
        ref={setNodeRef}
        data-chat={chat.agent.id}
        className={isDragging ? SLOT : ""}
        {...listeners}
      >
        <ChatRow chat={chat} current={current} onOpen={onOpen} />
      </li>
    </PinMenu>
  );
}

/**
 * The tiles' grid. With nothing pinned it is drawn only while a row is dragged, as the place to
 * drop it. A tile moved by the keyboard goes from tile to tile, so the grid itself is no place then.
 */
function PinnedGrid({
  tiles,
  byKeys,
  children,
}: {
  tiles: string[];
  byKeys: boolean;
  children: React.ReactNode;
}) {
  const { setNodeRef } = useDroppable({ id: PINNED, disabled: byKeys });
  return (
    <SortableContext items={tiles} strategy={rectSortingStrategy}>
      <ul
        ref={setNodeRef}
        aria-label="Pinned"
        className={`grid grid-cols-[repeat(auto-fill,minmax(88px,1fr))] gap-1 ${tiles.length === 0 ? "min-h-[90px] rounded-xl border border-dashed" : ""}`}
      >
        {children}
      </ul>
    </SortableContext>
  );
}

/**
 * What a drag is over: under a pointer, the tile it is on, or else the grid if it is in it; moved
 * by the keyboard, the nearest tile.
 */
const overWhat: CollisionDetection = (args) => {
  if (!args.pointerCoordinates) return closestCenter(args);
  const under = pointerWithin(args);
  const tile = under.find(({ id }) => id !== PINNED);
  return tile ? [tile] : under;
};

/** Keeps what follows a pointer centred under it, wherever on its tile or row it was picked up. */
const underPointer: Modifier = ({ activatorEvent, draggingNodeRect, transform }) =>
  draggingNodeRect && activatorEvent instanceof MouseEvent
    ? {
        ...transform,
        x:
          transform.x + activatorEvent.clientX - draggingNodeRect.left - draggingNodeRect.width / 2,
        y:
          transform.y + activatorEvent.clientY - draggingNodeRect.top - draggingNodeRect.height / 2,
      }
    : transform;

/**
 * Your conversations. The pinned ones come first, a tile each in a grid, in the order they were
 * put in; the rest follow, newest first, a row each. `current` is the agent of the one open beside
 * them. A right-click on one, a long press, or Shift+F10 while it has the keyboard, opens its menu:
 * Pin, or Unpin.
 *
 * With a mouse they are dragged: a tile to another place among the tiles, a row onto the tiles,
 * which pins it there, and a tile down off them, which unpins it. What follows the pointer is the
 * agent's face alone, and the place it would land in is kept empty for it as the others make room.
 * With the keyboard, Space picks a tile up and puts it down, the arrows move it, and Escape puts it
 * back; Enter opens it. A touch drags nothing: it scrolls, and held still it opens the menu.
 */
export function ChatList({
  chats,
  current,
  onOpen,
  className,
}: {
  chats: ListedChat[];
  current?: string | undefined;
  onOpen(agent: string): void;
  className: string;
}) {
  const { pins, pin } = useAllChats();
  // What was said today is read again when the day changes.
  useEvery(60_000);
  const list = useRef<HTMLUListElement>(null);
  /** The conversation just pinned or unpinned: the keyboard goes with it to where it is drawn now. */
  const moved = useRef<string>(undefined);
  useEffect(() => {
    if (!moved.current) return;
    list.current
      ?.querySelector<HTMLElement>(`[data-chat="${CSS.escape(moved.current)}"] button`)
      ?.focus();
    moved.current = undefined;
  });
  const sensors = useSensors(
    // A press that moves is a drag; one that stays is a click.
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: { start: ["Space"], cancel: ["Escape"], end: ["Space", "Enter"] },
    }),
  );
  /** While one is dragged: which, how, and the tiles as they would be were it dropped now. */
  const [drag, setDrag] = useState<{ id: string; byKeys: boolean; tiles: string[] }>();
  const byId = new Map(chats.map((chat) => [chat.agent.id, chat]));
  const kept = pins.filter((id) => byId.has(id));
  const tiles = drag?.tiles ?? kept;
  const nameOf = (id: unknown) => byId.get(String(id))?.agent.name ?? "";
  const shown = (id: string, pinned: boolean) => {
    const chat = byId.get(id);
    const Shown = pinned ? PinnedTile : ListedRow;
    return (
      chat && (
        <Shown
          key={id}
          chat={chat}
          current={id === current}
          onOpen={() => onOpen(id)}
          onPin={() => {
            moved.current = id;
            pin(id, !pinned);
          }}
        />
      )
    );
  };
  return (
    <DndContext
      sensors={sensors}
      collisionDetection={overWhat}
      accessibility={{
        announcements: {
          onDragStart: ({ active }) => `Picked up ${nameOf(active.id)}.`,
          onDragOver: ({ active, over }) =>
            over && over.id !== PINNED && over.id !== active.id
              ? `${nameOf(active.id)} is in ${nameOf(over.id)}'s place.`
              : undefined,
          onDragEnd: ({ active }) => `Put down ${nameOf(active.id)}.`,
          onDragCancel: ({ active }) => `${nameOf(active.id)} is back where it was.`,
        },
      }}
      onDragStart={({ active, activatorEvent }) =>
        setDrag({
          id: String(active.id),
          byKeys: activatorEvent instanceof KeyboardEvent,
          tiles: kept,
        })
      }
      // Off the tiles it is a row; on them it is a tile, put before the one it came in over, or last.
      onDragOver={({ active, over }) =>
        setDrag((was) => {
          const id = String(active.id);
          if (!was || was.tiles.includes(id) === !!over) return was;
          const rest = was.tiles.filter((one) => one !== id);
          const at = over ? rest.indexOf(String(over.id)) : -1;
          return {
            ...was,
            tiles: !over
              ? rest
              : at < 0
                ? [...rest, id]
                : [...rest.slice(0, at), id, ...rest.slice(at)],
          };
        })
      }
      onDragEnd={({ active, over }) => {
        setDrag(undefined);
        if (!drag) return;
        const id = String(active.id);
        // Among the tiles, it takes the place of the one it is dropped on.
        const from = drag.tiles.indexOf(id);
        const to = over ? drag.tiles.indexOf(String(over.id)) : -1;
        const now = from >= 0 && to >= 0 ? arrayMove(drag.tiles, from, to) : drag.tiles;
        const at = now.indexOf(id);
        if (at >= 0 && now.some((one, i) => one !== kept[i])) pin(id, true, now[at + 1]);
        if (at < 0 && kept.includes(id)) pin(id, false);
      }}
      onDragCancel={() => setDrag(undefined)}
    >
      <ul ref={list} aria-label="Chats" className={`${CHAT_ROWS} ${className}`}>
        {(tiles.length > 0 || drag) && (
          <li className="pb-2">
            <PinnedGrid tiles={tiles} byKeys={!!drag?.byKeys}>
              {tiles.map((id) => shown(id, true))}
            </PinnedGrid>
          </li>
        )}
        {chats.map(({ agent }) => !tiles.includes(agent.id) && shown(agent.id, false))}
      </ul>
      {createPortal(
        <DragOverlay modifiers={[underPointer]} dropAnimation={null}>
          {drag && byId.has(drag.id) && (
            <span data-dragged={drag.id} className="grid size-full place-items-center">
              <Face agent={(byId.get(drag.id) as ListedChat).agent} size={48} plain />
            </span>
          )}
        </DragOverlay>,
        document.body,
      )}
    </DndContext>
  );
}

/** The chat's one control over itself, whatever it shows: it collapses. */
export function CloseChats() {
  const { close } = useChats();
  return (
    <Button variant="ghost" size="icon-sm" aria-label="Close chats" onClick={close}>
      <XIcon />
    </Button>
  );
}
