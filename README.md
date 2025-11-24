# LinkedIn Jobs Scraper

An advanced Apify actor for scraping detailed job information from LinkedIn.

## Features

- **Advanced Job Data Extraction**: Scrapes comprehensive job details including:
  - Job title, company, and location
  - Complete job description
  - Salary information (when available)
  - Application metrics and posting date
  - Job requirements and qualifications
  - Company size and industry information

- **Multiple Search Queries**: Supports searching for multiple job titles/keywords simultaneously
- **Location-based Searching**: Search jobs in specific locations
- **Pagination Support**: Automatically handles multiple pages of results
- **Custom Data Extension**: Extend output with custom JavaScript functions
- **Robust Error Handling**: Built-in retry mechanisms and error management

## Input Configuration

### Required Parameters
- **searchQueries**: Array of job titles or keywords to search for
- **location**: Geographic location for job search

### Optional Parameters
- **maxResults**: Maximum number of jobs to scrape (default: 100)
- **maxConcurrency**: Number of concurrent requests (default: 5)
- **proxyConfiguration**: Proxy settings (default: uses Apify Proxy)
- **extendOutputFunction**: Custom JavaScript function to extend output
- **customData**: Additional custom data to include with each record

## Output Format

Each job record includes:
```json
{
  "url": "https://linkedin.com/jobs/view/123456",
  "title": "Senior Software Engineer",
  "company": "Tech Company Inc.",
  "location": "San Francisco, CA",
  "description": "Full job description...",
  "postedDate": "2 weeks ago",
  "applicants": "45 applicants",
  "salary": "$120,000 - $160,000",
  "requirements": ["Bachelor's degree", "5+ years experience"],
  "companySize": "1001-5000 employees",
  "companyIndustry": "Software Development",
  "searchQuery": "Software Engineer",
  "scrapedAt": "2024-01-15T10:30:00.000Z",
  "customData": {}
}
```

## Installation

1. Install dependencies:
```bash
npm install
```

2. Run locally:
```bash
npm start
```

## Deployment to Apify

1. Create a new actor in your Apify account
2. Upload the project files
3. Configure input parameters
4. Run the actor

## Customization

### Extending Output

You can provide a custom JavaScript function to extend the output:

```javascript
// Example extendOutputFunction
async function(job, $, request) {
    // Extract additional data
    job.customField = $('.custom-element').text().trim();
    
    // Calculate additional metrics
    job.estimatedSalaryRange = estimateSalary(job.description);
    
    return job;
}
```

## Legal Notice

⚠️ **Important**: This scraper should be used in compliance with:
- LinkedIn's Terms of Service
- Local laws and regulations
- Robots.txt directives

Always respect rate limiting and consider the ethical implications of web scraping.

## Support

For issues and questions:
- Check the Apify documentation
- Review the actor logs for errors
- Ensure proper proxy configuration

## Changelog

### v1.0.0
- Initial release with comprehensive job scraping
- Support for multiple search queries
- Advanced data extraction capabilities
- Custom output extension functionality