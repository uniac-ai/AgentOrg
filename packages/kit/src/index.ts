// @agentorg/kit: the shell's own components, for the shell and for every view. Importing it puts
// the kit's styles in the document it runs in (a view's frame, or the shell's page).
import { ensureKitStyles } from "./styles.ts";

ensureKitStyles();

export { Chat, type ChatEntry, type ChatProps } from "./chat.tsx";
export {
  Actions,
  Button,
  type ButtonProps,
  Card,
  Dialog,
  Field,
  Fill,
  IconButton,
  List,
  Menu,
  MenuItem,
  Meter,
  Row,
  Scroll,
  Select,
  Stack,
  Switch,
  Table,
  Tabs,
} from "./components.tsx";
export * from "./icons.tsx";
export { Markdown } from "./markdown.tsx";
export { ResizableGroup, ResizablePanel, ResizeHandle } from "./resizable.tsx";
export { ensureKitStyles, KIT_CSS } from "./styles.ts";
