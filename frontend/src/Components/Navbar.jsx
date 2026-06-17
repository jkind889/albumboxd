import { useEffect, useState } from 'react'
import { Link, useLocation } from 'react-router-dom'
import SearchBar from './Searchbar'
import {
  Show,
  SignInButton,
  SignUpButton,
  UserButton,
  useAuth,
} from '@clerk/react'

function Navbar()
{
    const { getToken, isLoaded, isSignedIn } = useAuth()
    const location = useLocation()
    const [unreadCount, setUnreadCount] = useState(0)

    useEffect(() => {
        let isCurrent = true

        async function fetchUnreadCount() {
            if (!isLoaded || !isSignedIn) {
                setUnreadCount(0)
                return
            }

            if (location.pathname === "/notifications") {
                setUnreadCount(0)
                return
            }

            try {
                const token = await getToken()
                const response = await fetch("http://localhost:3000/notifications/unread-count", {
                    headers: {
                        Authorization: `Bearer ${token}`,
                    },
                })

                if (!response.ok) {
                    throw new Error("Failed to fetch unread notifications")
                }

                const data = await response.json()

                if (isCurrent) {
                    setUnreadCount(Number(data.unreadCount) || 0)
                }
            } catch (error) {
                console.error(error)

                if (isCurrent) {
                    setUnreadCount(0)
                }
            }
        }

        fetchUnreadCount()

        return () => {
            isCurrent = false
        }
    }, [getToken, isLoaded, isSignedIn, location.pathname])

    return (
        <>
            <header className="site-header">
                <nav className="navbar navbar-expand site-navbar">
                    <div className="container-fluid site-navbar-inner">
                        <Link to="/" className="navbar-brand">albumboxd</Link>
                        <div className="navbar-collapse site-navbar-left">
                            <ul className="navbar nav site-nav-links">
                                <li className="nav-item">
                                    <Link to="/albums" className="nav-link active">Albums</Link>
                                </li>
                                <li className="nav-item">
                                    <Link to="/boards" className="nav-link active">Boards</Link>
                                </li>
                            </ul>
                        </div>
                        <div className="site-navbar-search">
                            <SearchBar />
                        </div>
                        <div className="nav navbar-right site-navbar-actions">
                            <Show when="signed-out">
                                <SignInButton mode="modal">
                                    <button type="button" className="nav-auth-button nav-auth-button-secondary">
                                        Sign in
                                    </button>
                                </SignInButton>
                                <SignUpButton mode="modal">
                                    <button type="button" className="nav-auth-button">
                                        Sign up
                                    </button>
                                </SignUpButton>
                            </Show>

                            <Show when="signed-in">
                                <Link to="/notifications" className="nav-link nav-notification-link active px-0" aria-label={`Notifications${unreadCount > 0 ? `, ${unreadCount} unread` : ""}`}>
                                    Notifications
                                    {unreadCount > 0 && (
                                        <span className="nav-notification-badge">{unreadCount > 99 ? "99+" : unreadCount}</span>
                                    )}
                                </Link>
                                <Link to="/account" className="nav-link active px-0">
                                    Account
                                </Link>
                                <UserButton afterSignOutUrl="/" />
                            </Show>
                        </div>
                    </div>
                </nav>
            </header>
        </>
    )

}

export default Navbar
