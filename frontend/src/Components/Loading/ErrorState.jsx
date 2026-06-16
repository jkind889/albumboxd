import AsyncState from "./AsyncState";

export default function ErrorState({ error, title = "Something went wrong" }) {
    return <AsyncState error={error} errorTitle={title} />;
}
