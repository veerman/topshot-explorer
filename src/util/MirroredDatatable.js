import React, {useEffect, useRef, useState} from "react"
import ReactDatatable from '@ashvin27/react-datatable'

// ReactDatatable only shows "Showing X to Y of Z entries" and the
// First/Previous/Next/Last controls below the table. This wrapper hides the
// library's own header and renders a single compact top bar - page-size
// select and info on the left, search with pagination under it on the
// right - driving the table through its class instance.
export function MirroredDatatable(props) {
    const tableRef = useRef(null)
    const lastPageSize = useRef(null)
    const [, setTick] = useState(0)
    const refresh = () => setTick((t) => t + 1)

    // the table re-renders itself on page/size/filter changes and reports
    // them via onChange; that is our cue to re-render the mirror
    const handleChange = (data) => {
        // the table keeps the current page when the page size changes, which
        // can strand the view past the last page; snap back to page 1
        if (lastPageSize.current !== null && data.page_size !== lastPageSize.current
            && Number(data.page_number) !== 1 && tableRef.current) {
            lastPageSize.current = data.page_size
            tableRef.current.goToPage({preventDefault: () => {}}, 1)
            return // goToPage fires onChange again
        }
        lastPageSize.current = data.page_size
        refresh()
        if (props.onChange) props.onChange(data)
    }

    useEffect(() => {
        refresh() // first render has no instance yet
    }, [])

    const t = tableRef.current
    const pageSize = t ? Number(t.state.page_size) : Number(props.config.page_size || 100)
    let info = ""
    let isFirst = true
    let isLast = true
    let pageNumber = 1
    let pages = 1
    if (t) {
        pageNumber = Number(t.state.page_number)
        const total = t.state.filter_value
            ? t.filterData(props.records).length
            : props.records.length
        pages = Math.max(1, Math.ceil(total / pageSize))
        const start = total === 0 ? 0 : (pageNumber - 1) * pageSize + 1
        const end = Math.min(pageNumber * pageSize, total)
        info = `Showing ${start} to ${end} of ${total} entries`
        isFirst = pageNumber <= 1
        isLast = pageNumber >= pages
    }

    const go = (fn) => (e) => {
        e.preventDefault()
        if (tableRef.current) fn(tableRef.current, e)
        refresh()
    }

    const sizeOptions = props.config.length_menu || [100]
    const compact = {height: "28px", fontSize: "13px", padding: "2px 6px", display: "inline-block", width: "auto"}

    return (
        <div>
            <div style={{display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "16px", marginBottom: "8px"}}>
                <div>
                    <label style={{display: "flex", alignItems: "center", gap: "6px", margin: 0, fontWeight: "normal"}}>
                        Show
                        <select className="form-control" style={compact} value={pageSize}
                            onChange={(e) => tableRef.current && tableRef.current.changePageSize(e)}>
                            {sizeOptions.map((n) => <option key={n} value={n}>{n}</option>)}
                            <option value={props.records.length}>All</option>
                        </select>
                        per page
                    </label>
                    <div style={{fontSize: "12px", color: "#78899a", marginTop: "8px"}}>{info}</div>
                </div>
                <div style={{textAlign: "right"}}>
                    <input type="search" className="form-control"
                        style={{...compact, height: "30px", width: "220px"}}
                        placeholder="Search in records..."
                        onChange={(e) => tableRef.current && tableRef.current.filterRecords(e)} />
                    <nav aria-label="Page navigation">
                        <ul className="pagination pagination-sm justify-content-end" style={{marginTop: "6px", marginBottom: 0}}>
                            <li className={(isFirst ? "disabled " : "") + "page-item"}>
                                <a href="#top" className="page-link" tabIndex="-1" onClick={go((t, e) => t.firstPage(e))}>First</a>
                            </li>
                            <li className={(isFirst ? "disabled " : "") + "page-item"}>
                                <a href="#top" className="page-link" tabIndex="-1" onClick={go((t, e) => t.previousPage(e))}>Previous</a>
                            </li>
                            <li className="page-item">
                                <span className="page-link">{pageNumber} / {pages}</span>
                            </li>
                            <li className={(isLast ? "disabled " : "") + "page-item"}>
                                <a href="#top" className="page-link" onClick={go((t, e) => t.nextPage(e))}>Next</a>
                            </li>
                            <li className={(isLast ? "disabled " : "") + "page-item"}>
                                <a href="#top" className="page-link" tabIndex="-1" onClick={go((t, e) => t.lastPage(e))}>Last</a>
                            </li>
                        </ul>
                    </nav>
                </div>
            </div>
            <ReactDatatable {...props}
                config={{...props.config, show_length_menu: false, show_filter: false}}
                ref={tableRef}
                onChange={handleChange} />
        </div>
    )
}
