import {Link} from 'react-router-dom'
import SearchBar  from './Searchbar';

function Navbar()
{
    
    return(
        <>
             <header>
                    <nav className="navbar navbar-expand">
                        <div className="container-fluid">
                            <Link to ="/Home" className="navbar-brand">YBGCORP</Link>
                            <div className="navbar-collapse">
                                <ul className="navbar nav">
                                <li className="nav-item">
                                    <Link to ="/reviews" className="nav-link active">Top Tracks</Link>
                                </li>
                                <li className="nav-item">
                                    <Link to ="/collection" className="nav-link active">Top Genres</Link>
                                </li>
                                <li className="nav-item">
                                    <Link to="/search" className="nav-link active">Top Artists</Link>
                                </li>
                                 <li className="nav-item">
                                    <Link to="/album/:id" className="nav-link active">Top Artists</Link>
                                </li>
                                <li className="nav-item">
                                    <Link to="/Callback" className="nav-link active">Top Artiss</Link>
                                </li>
                                 <li className="nav-item">
                                    <Link to="/" className="nav-link active">Top Artis</Link>
                                </li>
                                </ul>
                            </div>
                        </div>
                        <div className="nav navbar-right d-flex align-items-center gap-2">
                            <SearchBar/>
                            <Link to="/Account"> Account </Link>
                        </div>

                    </nav>
                 </header>

        </>
    )

}

export default Navbar
