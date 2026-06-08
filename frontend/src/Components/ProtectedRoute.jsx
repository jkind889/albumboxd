import {Navigate} from 'react-router-dom';
import { Show } from '@clerk/react';
function ProtectedRoute({ children }) {
    return (
        <>
        <Show when="signed-in">
            {children}
        </Show>
        <Show when="signed-out">
            <Navigate to="/" />
        </Show>
        </>
    )
}

export default ProtectedRoute;