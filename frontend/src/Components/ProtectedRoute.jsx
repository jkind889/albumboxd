import {Navigate} from 'react-router-dom';
import { SignedIn, SignedOut } from '@clerk/react';

function ProtectedRoute({ children }) {
    return (
        <>
        <SignedIn>
            {children}
        </SignedIn>
        <SignedOut>
            <Navigate to="/" />
        </SignedOut>
        </>
    )
}

export default ProtectedRoute;