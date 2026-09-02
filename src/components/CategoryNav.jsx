import { Link } from 'react-router-dom';
import { CATEGORIES } from '../constants/categories';

export default function CategoryNav() {
  return (
    <div className="bg-white shadow-sm border-b border-slate-100 overflow-x-auto">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex justify-between items-center py-4 min-w-[600px] md:justify-center md:gap-16">
          {CATEGORIES.map((cat) => (
            <Link 
              key={cat.id} 
              to={`/category/${cat.id}`}
              className="flex flex-col items-center gap-2 group hover:text-primary-600 transition-colors"
            >
              <div className="h-14 w-14 md:h-16 md:w-16 rounded-full bg-slate-50 flex items-center justify-center group-hover:bg-primary-50 transition-colors">
                <cat.icon className="h-6 w-6 md:h-7 md:w-7 text-slate-600 group-hover:text-primary-600" />
              </div>
              <span className="text-sm font-medium text-slate-700 group-hover:text-primary-600">{cat.name}</span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
