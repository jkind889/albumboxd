import AsyncState from "./AsyncState";

export function LoadingState({ message, variant = "page" }) {
   return <AsyncState isLoading loadingMessage={message} loadingVariant={variant} />;
}

export default LoadingState;
