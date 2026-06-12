import { Link } from 'react-router-dom'
import SearchBar from './Searchbar'
import {
  Show,
  SignInButton,
  SignUpButton,
  UserButton,
} from '@clerk/react'

function Navbar()
{

    return (
        <>
            <header className="site-header">
                <nav className="navbar navbar-expand site-navbar">
                    <div className="container-fluid site-navbar-inner">
                        <Link to="/" className="navbar-brand">albumboxd</Link>
                        <div className="navbar-collapse site-navbar-left">
                            <ul className="navbar nav site-nav-links">
                                <li className="nav-item">
                                    <Link to="/viewreviews" className="nav-link active">Reviews</Link>
                                </li>
                                <li className="nav-item">
                                    <Link to="/collection" className="nav-link active">Collection</Link>
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
