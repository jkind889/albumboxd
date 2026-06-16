import AsyncState from "./AsyncState";

export default function EmptyState({ message, title = "Nothing here yet" }) {
   return <AsyncState isEmpty emptyTitle={title} emptyBody={message} />;
}
