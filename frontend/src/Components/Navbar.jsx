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
            <header>
                <nav className="navbar navbar-expand">
                    <div className="container-fluid">
                        <Link to="/" className="navbar-brand">albumboxd</Link>
                        <div className="navbar-collapse">
                            <ul className="navbar nav">
                                <li className="nav-item">
                                    <Link to="/viewreviews" className="nav-link active">Reviews</Link>
                                </li>
                                <li className="nav-item">
                                    <Link to="/collection" className="nav-link active">Collection</Link>
                                </li>
                                <li className="nav-item">
                                    <SearchBar />
                                </li>
                            </ul>
                        </div>
                        <div className="nav navbar-right d-flex align-items-center gap-2">
                            <Show when="signed-out">
                                <SignInButton mode="modal">
                                    <button type="button" className="btn btn-outline-dark">
                                        Sign in
                                    </button>
                                </SignInButton>
                                <SignUpButton mode="modal">
                                    <button type="button" className="btn btn-dark">
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
